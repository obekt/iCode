/**
 * HTTP + WebSocket server entry point.
 * Serves the mobile web UI, provides /api/projects, and upgrades to WebSocket for PTY.
 */

import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import { WebSocketServer } from "ws";
import { handleConnection } from "./pty.ts";

const PORT = Number(process.env.PORT) || 3333;
const CWD = process.env.ICODE_CWD || process.cwd();
const CLIENT_DIR = new URL("../../dist/client", import.meta.url).pathname;
const SRC_CLIENT_DIR = new URL("../../src/client", import.meta.url).pathname;

const PROJECTS_FILE = join(homedir(), ".config", "icode", "projects.json");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".map": "application/json",
};

async function loadProjects(): Promise<string[]> {
  try {
    const data = await readFile(PROJECTS_FILE, "utf-8");
    return JSON.parse(data) as string[];
  } catch {
    return [];
  }
}

async function saveProjects(projects: string[]): Promise<void> {
  const dir = join(homedir(), ".config", "icode");
  await mkdir(dir, { recursive: true });
  await writeFile(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

async function addProject(cwd: string): Promise<void> {
  const projects = await loadProjects();
  // Move to front if exists, otherwise prepend
  const filtered = projects.filter((p) => p !== cwd);
  filtered.unshift(cwd);
  // Keep at most 20
  await saveProjects(filtered.slice(0, 20));
}

// Track initial project
addProject(CWD);

const server = createServer(async (req, res) => {
  const url = req.url === "/" ? "/index.html" : req.url ?? "/index.html";

  // API: list projects
  if (url === "/api/projects") {
    if (req.method === "GET") {
      const projects = await loadProjects();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(projects));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { cwd: newCwd } = JSON.parse(body) as { cwd: string };
          await addProject(newCwd);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end("Bad request");
        }
      });
      return;
    }
    if (req.method === "DELETE") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { cwd: delCwd } = JSON.parse(body) as { cwd: string };
          const projects = await loadProjects();
          await saveProjects(projects.filter((p) => p !== delCwd));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end("Bad request");
        }
      });
      return;
    }
  }

  // Serve static files — strip query strings for cache busting
  const cleanUrl = url.split("?")[0];
  const ext = extname(cleanUrl);
  let filePath = join(CLIENT_DIR, cleanUrl);
  if (ext === ".html") {
    filePath = join(SRC_CLIENT_DIR, cleanUrl);
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  handleConnection(ws);
});

server.listen(PORT, "0.0.0.0", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : PORT;
  console.log(`icode server running on http://0.0.0.0:${port}`);
  console.log(`Working directory: ${CWD}`);
  console.log(`Open on iPhone: http://<your-mac-ip>:${port}`);
});
