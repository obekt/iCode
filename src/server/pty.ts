/**
 * PTY manager — spawns `claude` CLI via node-pty, handles WebSocket protocol.
 *
 * WebSocket protocol (client → server):
 *   "0<data>"       — stdin input
 *   "1<cols>,<rows>" — resize
 *   "2<json>"       — spawn session: {"cwd":"/path"}
 *
 * Server → client:
 *   raw string      — PTY output (no prefix)
 *   "\x01<json>"    — control message: {"type":"spawned",...} or {"type":"exited",...}
 *                      or {"type":"ready"} (waiting for project selection)
 *                      or {"type":"error","message":"..."}
 */

import * as pty from "node-pty";
import { execSync } from "node:child_process";
import { stat } from "node:fs/promises";
import type { WebSocket } from "ws";

// Resolve claude binary path at startup via login shell so we get the full PATH
const CLAUDE_BIN = (() => {
  try {
    return execSync("zsh -lc 'which claude'", { encoding: "utf-8" }).trim();
  } catch {
    return "/Users/" + process.env.USER + "/.local/bin/claude";
  }
})();

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

export function handleConnection(ws: WebSocket): void {
  let activePty: pty.IPty | null = null;
  let activeId = 0;

  function killActive(): void {
    if (activePty) {
      const p = activePty;
      activePty = null;
      try { p.kill(); } catch { /* already dead */ }
    }
  }

  async function startSession(cwd: string): Promise<void> {
    // Validate path before spawning
    if (!await isDirectory(cwd)) {
      sendControl(ws, { type: "error", message: `Not a valid directory: ${cwd}` });
      return;
    }

    killActive();

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.TERM = env.TERM || "xterm-256color";
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SESSION;

    const id = ++activeId;
    let proc: pty.IPty;
    try {
      proc = pty.spawn(CLAUDE_BIN, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env,
      });
    } catch (err) {
      sendControl(ws, { type: "error", message: `Failed to start: ${err}` });
      return;
    }

    activePty = proc;

    proc.onData((data) => {
      if (id !== activeId) return;
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    });

    proc.onExit(({ exitCode }) => {
      if (id !== activeId) return;
      sendControl(ws, { type: "exited", code: exitCode, cwd });
      activePty = null;
    });

    sendControl(ws, { type: "spawned", cwd, pid: proc.pid });
  }

  // Don't auto-spawn — send ready signal and wait for project selection
  sendControl(ws, { type: "ready" });

  ws.on("message", (raw) => {
    const msg = raw.toString();
    if (msg.length === 0) return;

    const prefix = msg[0];
    const payload = msg.slice(1);

    switch (prefix) {
      case "0":
        if (activePty) {
          const filtered = payload.replace(/\x1b\[[IO]/g, "");
          if (filtered) {
            try { activePty.write(filtered); } catch { /* pty dead */ }
          }
        }
        break;

      case "1": {
        const parts = payload.split(",");
        const cols = parseInt(parts[0], 10);
        const rows = parseInt(parts[1], 10);
        if (activePty && cols > 0 && rows > 0) {
          try { activePty.resize(cols, rows); } catch { /* pty dead */ }
        }
        break;
      }

      case "2": {
        try {
          const { cwd } = JSON.parse(payload) as { cwd: string };
          if (cwd) startSession(cwd);
        } catch { /* ignore malformed */ }
        break;
      }
    }
  });

  ws.on("close", () => {
    killActive();
  });
}
