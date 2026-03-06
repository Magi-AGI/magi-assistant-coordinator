# Magi Assistant Coordinator

## Project

TypeScript/Node.js WebSocket server that multiplexes terminal sessions for Magi smart glasses clients. Runs on the user's PC, glasses connect over Tailscale.

## Architecture

```
PTY (bash/agent) → VirtualTerminalBuffer (xterm.js headless) → SnapshotPipeline → WebSocket → Glasses
```

- **Session**: Composes PtyHost + VTB + SnapshotPipeline
- **SessionManager**: Creates/lists sessions from config
- **WebSocketServer**: Auth, message routing, broadcast
- **ClientConnection**: Per-client state (auth, grid, activeSessionId)

## Toolchain

- **Node.js** ≥20, **TypeScript** ^5.7
- **ws** ^8.18 (WebSocket), **@xterm/headless** ^5.5 (terminal), **node-pty** ^1.0 (PTY)
- **vitest** ^3.0 (tests), **tsx** (dev runner)

## Build & Run

```bash
npm install
npm run dev          # tsx watch mode
npm start            # production
npm test             # vitest
npm run mock-client  # manual testing tool
```

## Configuration

Via `.env` file or environment variables:

| Var | Default | Description |
|-----|---------|-------------|
| `MAGI_PORT` | 9100 | WebSocket listen port |
| `MAGI_TOKEN` | (required) | Static auth token |
| `MAGI_SESSIONS` | `[]` | JSON array of session configs |
| `MAGI_LOG_LEVEL` | info | Log level |

## Protocol

JSON over WebSocket. Every message has `"type"` field.

### Client → Coordinator
- `client.hello` — authenticate + report grid size
- `session.list` — request available sessions
- `session.switch` — switch active session
- `client.grid` — report grid resize

### Coordinator → Client
- `hello.ok` — auth success + initial state
- `session.screen` — terminal snapshot
- `session.list.result` — session list
- `session.switched` — switch confirmed
- `error` — error message

## Conventions

- No schema validation library (4 message types, trivial)
- No HTTP framework (ws creates its own server)
- Snapshot pipeline: 50ms debounce → 10 FPS cap → broadcast
- Backpressure: pause PTY if VTB pending > 1MB, resume at 50%
