# icode

Remote-control Claude Code from an iPhone via a mobile web UI. Runs as a Node.js server on your Mac; connect from iPhone Safari over the local network. Streams the real Claude Code terminal (colors, permissions, everything) via PTY + xterm.js.

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Build:** esbuild
- **Server:** `ws` (WebSocket), built-in `http`
- **Claude integration:** Direct PTY spawn of `claude` CLI via `node-pty`
- **Terminal:** `xterm.js` + `@xterm/addon-fit` (browser render)
- **Frontend:** Vanilla HTML/JS — no framework

## Commands

```bash
npm run build        # Bundle with esbuild
npm run dev          # Start dev server (watch mode)
npm run lint         # Lint
```

## Project Structure

```
src/
  server/
    index.ts    # HTTP server, /api/projects endpoint, WebSocket attachment
    pty.ts      # Spawns `claude` via node-pty, handles WS ↔ PTY protocol
  client/
    index.html  # Mobile-first UI: header, xterm.js terminal, project picker
    app.ts      # xterm.js + FitAddon + WS wiring + project picker logic
```

## Architecture

### Data Flow

```
iPhone Safari ←WebSocket→ Node server ←PTY→ claude CLI
```

1. Server spawns `claude` CLI in a PTY (node-pty)
2. Raw terminal output streamed via WebSocket → xterm.js renders it identically
3. User interacts directly with the terminal (typing, permissions, everything)
4. Project switching kills PTY and spawns a new one in a different directory

### WebSocket Protocol (prefix-byte)

Client → Server:
- `0<data>` — stdin input
- `1<cols>,<rows>` — terminal resize
- `2<json>` — spawn new session: `{"cwd":"/path/to/project"}`

Server → Client:
- Raw string — PTY output (no prefix)
- `\x01<json>` — control message: `{"type":"spawned","cwd":"...","pid":123}` or `{"type":"exited","code":0}`

### Project Switching

- `GET /api/projects` — returns list of recent project paths
- `POST /api/projects` — adds a project path to the list
- Recent projects stored in `~/.config/icode/projects.json`
- Client shows a bottom-sheet project picker

### Process Lifecycle

- One PTY per WebSocket connection
- PTY killed when client disconnects or switches projects
- Session exit reported via control message

## Mobile UI Notes

- **iPhone Safari first** — test in Safari, handle viewport quirks and safe areas
- **Touch targets:** minimum 44px
- **No separate input bar** — xterm.js IS the input (tap terminal → iOS keyboard)
- **Permission prompts** appear natively in the terminal (Claude Code handles them)
- **Terminal font:** Menlo, 14px minimum
- **Layout:** portrait-primary, header + full-screen terminal
- **Project picker:** bottom sheet overlay with recent list + custom path input

## Conventions

- Single responsibility per module — keep files focused
- Errors: fail loudly on server, show user-friendly messages on client
- No heavy abstractions — direct, readable code over clever patterns
- TypeScript strict mode
