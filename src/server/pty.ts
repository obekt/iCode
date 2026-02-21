/**
 * PTY manager — spawns `claude` CLI via node-pty, manages persistent sessions.
 *
 * Sessions survive browser reloads. When a client reconnects and selects
 * the same project, it reattaches to the existing PTY and replays recent output.
 *
 * WebSocket protocol (client → server):
 *   "0<data>"       — stdin input
 *   "1<cols>,<rows>" — resize
 *   "2<json>"       — spawn/attach session: {"cwd":"/path"}
 *
 * Server → client:
 *   raw string      — PTY output (no prefix)
 *   "\x01<json>"    — control: spawned, attached, exited, error, ready
 */

import * as pty from "node-pty";
import { execSync } from "node:child_process";
import { stat } from "node:fs/promises";
import type { WebSocket } from "ws";

// Resolve claude binary path at startup
const CLAUDE_BIN = (() => {
  try {
    return execSync("zsh -lc 'which claude'", { encoding: "utf-8" }).trim();
  } catch {
    return "/Users/" + process.env.USER + "/.local/bin/claude";
  }
})();

// How much output to buffer for replay on reconnect
const REPLAY_BUFFER_SIZE = 64 * 1024; // 64KB

interface Session {
  pty: pty.IPty;
  cwd: string;
  buffer: string;
  alive: boolean;
}

// Global session store: cwd → session
const sessions = new Map<string, Session>();

function sendControl(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    ws.send("\x01" + JSON.stringify(msg));
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

function spawnSession(cwd: string): Session {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.TERM = env.TERM || "xterm-256color";
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION;

  const proc = pty.spawn(CLAUDE_BIN, ["--permission-mode", "acceptEdits"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env,
  });

  const session: Session = { pty: proc, cwd, buffer: "", alive: true };

  // Always buffer output for replay
  proc.onData((data) => {
    session.buffer += data;
    // Trim buffer if too large
    if (session.buffer.length > REPLAY_BUFFER_SIZE * 1.5) {
      session.buffer = session.buffer.slice(-REPLAY_BUFFER_SIZE);
    }
  });

  proc.onExit(() => {
    session.alive = false;
    sessions.delete(cwd);
  });

  sessions.set(cwd, session);
  return session;
}

export function handleConnection(ws: WebSocket): void {
  let currentSession: Session | null = null;
  let disposables: { dispose(): void }[] = [];

  function detach(): void {
    for (const d of disposables) d.dispose();
    disposables = [];
    currentSession = null;
  }

  function attach(session: Session): void {
    detach();
    currentSession = session;

    // Stream new output to this client
    disposables.push(session.pty.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }));

    // Notify on exit
    disposables.push(session.pty.onExit(({ exitCode }) => {
      sendControl(ws, { type: "exited", code: exitCode, cwd: session.cwd });
      currentSession = null;
    }));
  }

  async function selectProject(cwd: string): Promise<void> {
    if (!await isDirectory(cwd)) {
      sendControl(ws, { type: "error", message: `Not a valid directory: ${cwd}` });
      return;
    }

    // Check for existing session
    const existing = sessions.get(cwd);
    if (existing && existing.alive) {
      attach(existing);
      // Replay buffered output so user sees where they left off
      if (existing.buffer && ws.readyState === ws.OPEN) {
        ws.send(existing.buffer);
      }
      sendControl(ws, { type: "attached", cwd, pid: existing.pty.pid });
      return;
    }

    // Spawn new session
    let session: Session;
    try {
      session = spawnSession(cwd);
    } catch (err) {
      sendControl(ws, { type: "error", message: `Failed to start: ${err}` });
      return;
    }

    attach(session);
    sendControl(ws, { type: "spawned", cwd, pid: session.pty.pid });
  }

  // Wait for project selection
  sendControl(ws, { type: "ready" });

  ws.on("message", (raw) => {
    const msg = raw.toString();
    if (msg.length === 0) return;

    const prefix = msg[0];
    const payload = msg.slice(1);

    switch (prefix) {
      case "0":
        if (currentSession?.alive) {
          const filtered = payload.replace(/\x1b\[[IO]/g, "");
          if (filtered) {
            try { currentSession.pty.write(filtered); } catch { /* pty dead */ }
          }
        }
        break;

      case "1": {
        const parts = payload.split(",");
        const cols = parseInt(parts[0], 10);
        const rows = parseInt(parts[1], 10);
        if (currentSession?.alive && cols > 0 && rows > 0) {
          try { currentSession.pty.resize(cols, rows); } catch { /* pty dead */ }
        }
        break;
      }

      case "2": {
        try {
          const { cwd } = JSON.parse(payload) as { cwd: string };
          if (cwd) {
            detach();
            selectProject(cwd);
          }
        } catch { /* ignore malformed */ }
        break;
      }
    }
  });

  // On disconnect: detach but DON'T kill the PTY
  ws.on("close", () => {
    detach();
  });
}
