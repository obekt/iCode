/**
 * Client entry — xterm.js terminal connected to server PTY via WebSocket.
 * Handles terminal I/O, resize, and project switching.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { ITheme } from "@xterm/xterm";

// ── Elements ──
const terminalEl = document.getElementById("terminal")!;
const projectBtn = document.getElementById("project-btn")!;
const projectLabel = document.getElementById("project-label")!;
const connDot = document.getElementById("conn-dot")!;
const pickerOverlay = document.getElementById("project-picker")!;
const pickerList = document.getElementById("picker-list")!;
const pickerInput = document.getElementById("picker-input") as HTMLInputElement;
const pickerGo = document.getElementById("picker-go")!;
const pickerClose = document.getElementById("picker-close")!;

// ── Themes ──
const darkTheme: ITheme = {
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#58a6ff",
  selectionBackground: "#264f78",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39d353",
  white: "#e6edf3",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d364",
  brightWhite: "#f0f6fc",
};

const lightTheme: ITheme = {
  background: "#ffffff",
  foreground: "#1f2328",
  cursor: "#0969da",
  selectionBackground: "#add6ff",
  black: "#24292f",
  red: "#cf222e",
  green: "#1a7f37",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#2da44e",
  brightYellow: "#bf8700",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

const isDark = window.matchMedia("(prefers-color-scheme: dark)");

function getTheme(): ITheme {
  return isDark.matches ? darkTheme : lightTheme;
}

// ── Terminal setup ──
const term = new Terminal({
  fontSize: 18,
  fontFamily: "'Menlo', 'SF Mono', 'Monaco', 'Consolas', monospace",
  theme: getTheme(),
  cursorBlink: true,
  scrollback: 5000,
  allowProposedApi: true,
  ignoreBracketedPasteMode: false,
});

const fitAddon = new FitAddon();
const unicode11 = new Unicode11Addon();
term.loadAddon(fitAddon);
term.loadAddon(unicode11);
term.unicode.activeVersion = "11";
term.open(terminalEl);

// Switch theme when system preference changes
isDark.addEventListener("change", () => {
  term.options.theme = getTheme();
});

// Initial fit + focus
requestAnimationFrame(() => {
  fitAddon.fit();
  term.focus();
});

// ── Key bar ──
document.querySelectorAll("#key-bar button").forEach((btn) => {
  (btn as HTMLButtonElement).onclick = () => {
    const seq = (btn as HTMLButtonElement).dataset.seq || "";
    if (seq) sendData(seq);
  };
});

// Tap terminal to focus (iOS needs explicit focus trigger).
// Only focus on taps (no movement), not scrolls.
let touchMoved = false;
terminalEl.addEventListener("touchstart", () => { touchMoved = false; }, { passive: true });
terminalEl.addEventListener("touchmove", () => { touchMoved = true; }, { passive: true });
terminalEl.addEventListener("touchend", () => {
  if (touchMoved || !pickerOverlay.hidden) return;
  term.focus();
}, { passive: true });

// ── WebSocket ──
let ws: WebSocket | null = null;
let currentCwd = "";

function setConnected(connected: boolean): void {
  connDot.className = "conn-dot " + (connected ? "connected" : "disconnected");
}

function setProject(cwd: string): void {
  currentCwd = cwd;
  const name = cwd.split("/").pop() || cwd;
  projectLabel.textContent = name;
  projectLabel.title = cwd;
}

function connect(): void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    setConnected(true);
    sendResize();
  };

  ws.onmessage = (e) => {
    const data = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);

    // Check for control message (prefix \x01)
    if (data.length > 0 && data.charCodeAt(0) === 1) {
      handleControl(data.slice(1));
      return;
    }

    // Raw PTY output → terminal
    term.write(data);
  };

  ws.onclose = () => {
    setConnected(false);
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function handleControl(json: string): void {
  try {
    const msg = JSON.parse(json) as { type: string; cwd?: string; pid?: number; code?: number; message?: string };
    switch (msg.type) {
      case "ready":
        // Server connected, no session yet — open project picker
        projectLabel.textContent = "select project";
        openPicker();
        break;
      case "spawned":
        if (msg.cwd) setProject(msg.cwd);
        break;
      case "attached":
        // Reconnected to existing session — don't clear terminal
        if (msg.cwd) setProject(msg.cwd);
        break;
      case "exited":
        term.writeln(`\r\n\x1b[90m[session exited with code ${msg.code}]\x1b[0m`);
        break;
      case "error":
        term.writeln(`\r\n\x1b[31m${msg.message || "Unknown error"}\x1b[0m`);
        break;
    }
  } catch {
    // ignore
  }
}

function sendData(data: string): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send("0" + data);
  }
}

function sendResize(): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(`1${term.cols},${term.rows}`);
  }
}

function sendSpawn(cwd: string): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send("2" + JSON.stringify({ cwd }));
    term.clear();
  }
}

// Terminal input → WebSocket → PTY stdin
term.onData((data) => {
  sendData(data);
});

// ── Resize handling ──
const resizeObserver = new ResizeObserver(() => {
  fitAddon.fit();
  sendResize();
});
resizeObserver.observe(terminalEl);

// Handle visualViewport resize (iOS keyboard show/hide)
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => {
    fitAddon.fit();
    sendResize();
  });
}

// ── Project picker ──
function openPicker(): void {
  pickerOverlay.hidden = false;
  loadProjects();
}

function closePicker(): void {
  pickerOverlay.hidden = true;
  term.focus();
}

async function loadProjects(): Promise<void> {
  try {
    const res = await fetch("/api/projects");
    const projects = (await res.json()) as string[];
    pickerList.innerHTML = "";
    for (const p of projects) {
      const row = document.createElement("div");
      row.className = "picker-row" + (p === currentCwd ? " active" : "");

      const item = document.createElement("button");
      item.className = "picker-item";
      const name = p.split("/").pop() || p;
      item.innerHTML = `<span class="picker-item-name">${esc(name)}</span><span class="picker-item-path">${esc(p)}</span>`;
      item.onclick = () => {
        sendSpawn(p);
        closePicker();
      };

      const del = document.createElement("button");
      del.className = "picker-delete";
      del.textContent = "\u00d7";
      del.onclick = async (e) => {
        e.stopPropagation();
        await fetch("/api/projects", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: p }),
        });
        loadProjects();
      };

      row.appendChild(item);
      row.appendChild(del);
      pickerList.appendChild(row);
    }
  } catch {
    pickerList.innerHTML = '<div style="color:#8b949e;padding:12px">Failed to load projects</div>';
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

projectBtn.onclick = openPicker;
pickerClose.onclick = closePicker;
pickerOverlay.onclick = (e) => {
  if (e.target === pickerOverlay) closePicker();
};

pickerGo.onclick = () => {
  const cwd = pickerInput.value.trim();
  if (cwd) {
    sendSpawn(cwd);
    pickerInput.value = "";
    closePicker();
    fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
  }
};

pickerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    pickerGo.click();
  }
});

// ── Start ──
connect();
