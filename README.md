# Away

Your agents. Your laptop. Anywhere.

Away is a laptop companion and phone app for controlling the coding agents already installed on your laptop: Pi, Claude Code, and Codex.

> **Status: local development only.** The remote path works end to end on one machine, but the security design ([docs/security.md](docs/security.md)) has not been reviewed and has open items. Do not run a public relay yet. The desktop (Electron) and mobile (Expo) apps are being built; a terminal client stands in for the phone.

## How it fits together

```
 phone / away-remote ──wss──▶ relay ◀──wss── laptop companion (away serve) ──▶ pi --mode rpc
                                                                                ──▶ Claude Code (Agent SDK)
                                                                                ──▶ codex app-server
         └──────── Noise IK end-to-end encryption ────────┘
```

- Both sides make outgoing connections to the relay, so no port forwarding is needed.
- The relay only forwards encrypted frames. The phone and laptop authenticate each other with keys exchanged during pairing.
- The companion owns the agent processes. A phone disconnecting does not stop an agent.

| Package | Purpose |
|---|---|
| `packages/protocol` | Zod schemas: agent events, capabilities, pairing offers, encrypted messages, relay control |
| `packages/secure-channel` | Noise IK handshake and transport (via `noise-handshake`), with fragmentation |
| `packages/adapter-core` | The `AgentAdapter` / `AgentSession` interface and a JSONL splitter |
| `packages/adapter-pi` | Drives Pi through its official RPC mode (`pi --mode rpc`) |
| `packages/adapter-claude` | Drives Claude Code through the official Agent SDK, using the installed `claude` |
| `packages/adapter-codex` | Drives Codex through `codex app-server` (JSON-RPC over stdio) |
| `packages/companion` | Laptop side: sessions, SQLite state, device pairing and auth, relay link, `away` CLI |
| `packages/client` | Device side: pairing, reconnecting connection, command outbox, event catch-up |
| `apps/desktop` | Electron app (Forge + Vite + React + Tailwind): runs the companion, pairing, projects, devices, tray |
| `apps/mobile` | Expo + Expo Router app: pair by QR, chat with agents, approvals, stop, resume |
| `apps/relay` | Fastify + WebSocket relay |
| `apps/remote-cli` | `away-remote`, a terminal stand-in for the phone app |

## Development

Requirements: Node.js 24+ (developed on 26) and pnpm via Corepack (`corepack enable`; corepack 0.36+ is needed for pnpm 12).
There is no build step: Node runs the TypeScript sources directly by stripping types, and `tsc` only typechecks.

```bash
pnpm install
pnpm typecheck
pnpm test
```

## Desktop app

```bash
pnpm relay                                  # terminal 1
pnpm --filter @away/desktop start           # terminal 2
```

The companion runs inside the app in an Electron `utilityProcess`. Closing the window keeps Away running in the menu bar; "Quit Away" stops the agents and remote access. Only one instance can run at a time. ⌘1–⌘4 switch pages, ⌘P shows a pairing code. `AWAY_DEV_SCREENSHOTS=<folder>` saves a screenshot of each page in development.

## Mobile app

```bash
cd apps/mobile && npx expo start   # press i for the iOS simulator, or scan with Expo Go
```

The simulator can reach a relay on `ws://127.0.0.1`. A physical phone needs the relay behind `wss://` (not set up yet). `EXPO_PUBLIC_AWAY_AUTOTEST_OFFER="$(pnpm --silent away pair)"` makes a development build pair, run a Pi prompt and a Codex approval, and log `PASS` or `FAIL` in the Expo terminal.

## Try it locally

Use three terminals in the repository root.

```bash
# 1. Relay (binds to 127.0.0.1:8787)
pnpm relay

# 2. Laptop companion: allow a project folder, then serve
pnpm away projects add /path/to/project
pnpm away serve

# 3. "Phone": pair once with a fresh single-use offer, then connect
pnpm remote pair "$(pnpm --silent away pair)"
pnpm remote
```

`pnpm away pair` prints an `away://pair?...` offer that is valid for 5 minutes and works once. On a real phone it will be shown as a QR code.

Inside `pnpm remote`, type `/help`. `/projects` then `/start 1` starts Pi in the first project (`/start 1 codex` or `/start 1 claude` for the others); plain lines are sent as prompts. Approvals are answered with `/allow`, `/always` (allow for this session), or `/deny [reason]`, and questions with `/answer`. `/drop` simulates a network drop, `/stop` interrupts the current turn, `/quit` leaves the agent running on the laptop.

Other laptop commands: `pnpm away devices list`, `pnpm away devices revoke <id>`, `pnpm away projects list`.

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `AWAY_HOME` | `~/.away` | Companion keys and database |
| `AWAY_REMOTE_HOME` | `~/.away-remote` | Remote client keys and paired laptop |
| `AWAY_RELAY_URL` | `ws://127.0.0.1:8787` | Relay URL (`wss://` required except for localhost) |
| `AWAY_PI_COMMAND` | `pi` | Pi executable |
| `AWAY_CLAUDE_COMMAND` | `claude` | Claude Code executable |
| `AWAY_CODEX_COMMAND` | `codex` | Codex executable |
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Relay listen address |

Each agent runs with your own installation, configuration, and login, in the project folder, with your user's permissions.

## Agents

| Agent | Interface | Approvals | Questions | Verified |
|---|---|---|---|---|
| Pi 1.1+ | `pi --mode rpc` (JSONL) | None: Pi does not gate tool calls | Extension dialogs | Fake Pi; real Pi startup and errors (no provider was logged in) |
| Codex 0.162+ | `codex app-server` (JSON-RPC, marked experimental by Codex) | Commands and file changes, per your `config.toml` approval policy | `requestUserInput` (experimental in Codex) | Fake app-server; real Codex: start, streaming, completion, interrupt |
| Claude Code 2.1+ | Agent SDK 0.3.296 with your installed `claude` | `canUseTool`, per your permission settings | `AskUserQuestion` | Fake SDK only; not run live |

- **Pi** needs a logged-in provider (`pi`, then `/login`).
- **Codex** uses your `config.toml` unchanged, including MCP servers and hooks. Only the working folder is set by Away. MCP elicitation requests are declined for now.
- **Claude Code** loads your user, project, and local settings and CLAUDE.md, uses the `claude_code` system prompt preset, and leaves the permission mode to your settings. The SDK also downloads its own bundled Claude Code binary (about 230 MB), which Away does not use.
- **Authentication:** Anthropic's Agent SDK documentation says third-party developers may not offer claude.ai login (subscription) in their products without approval, and should use API keys. Away currently uses whatever authentication your Claude Code has. This must be decided before the Claude adapter is offered to anyone else.

## Behavior worth knowing

- **Command status.** Each command has a client-generated id. The client shows `submitted` (only on the device), `received` (stored by the laptop), `accepted` (the agent took the prompt), then `completed`, `failed`, or `interrupted`.
- **Reconnects.** The client resends unfinished commands with the same id. The laptop never runs an id twice; it answers with the stored status. Session events carry sequence numbers, and a reconnecting client asks for everything after the last one it saw.
- **Busy agents.** A prompt sent while the agent is working is refused, not queued.
- **Restarts.** Agent processes end when the companion stops. On the next start, unfinished commands are marked failed (with "outcome unknown" if the agent had accepted them) and are never resent. An ended session can be resumed with `/resume` if the agent supports it.
- **Three kinds of stop.** `/stop` interrupts the current turn. Disconnecting a device does nothing to the agent. `/close` or stopping the companion ends the agent process.
- **Storage.** `~/.away` holds the laptop keys (`identity.json`) and `away.db` (devices, projects, session event log, command statuses), all readable only by your user. Agent history stays in the agent's own storage.

## How the Pi adapter works

- Away starts `pi --mode rpc` in the selected folder and exchanges JSON Lines over stdin/stdout. It never parses terminal output.
- Records are split on LF only. Node's `readline` is avoided because it also splits on U+2028/U+2029, which are valid inside JSON strings.
- A prompt resolves when Pi accepts it. Completion is a separate `run_settled` event.
- Pi does not gate tool calls behind approvals, so the adapter reports `toolApprovals: false`. Dialogs opened by Pi extensions (select/confirm/input/editor) are forwarded as questions.
- Pi's stderr is kept as a local, in-memory tail for debugging and is never forwarded to clients.

Smoke test against your real Pi (uses `--no-session`, so nothing is added to Pi's history):

```bash
pnpm --filter @away/adapter-pi smoke --cwd /path/to/project --prompt "Say hi"
```
