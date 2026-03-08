# ClearClaw — Architecture

Transparent relay between chat channels and CLI agents. See [OVERVIEW.md](OVERVIEW.md) for strategy and rationale.

## Concepts

| Term | What it is | Scope |
|------|-----------|-------|
| **Bot** | A chat platform identity (token, username). The transport-layer messenger. E.g., a Telegram bot, a Slack app. | One per ClearClaw instance |
| **Agent** | An engine personality — defined by configuration in a workspace's `cwd` (e.g., CLAUDE.md, skills, permissions, MCP config for Claude Code). ClearClaw does not model agents; the engine does. | Lives in the workspace's `cwd` |
| **Channel** | A delivery channel — the platform adapter (Telegram, Slack, etc.) that handles sending/receiving messages, buttons, and typing indicators. | One per platform per instance |
| **Chat** | A conversation on a platform — a Telegram group, a DM, a Slack channel. Identified by `chat_id` with a platform prefix (e.g., `tg:123456`, `slack:C1234`). Platform names differ (Telegram "group", Slack "channel") but ClearClaw calls them all "chats". | Many per instance |
| **Workspace** | A named work context: `cwd` + session + chat binding. The unit of isolation within an instance. | One per chat, many per instance |
| **ClearClaw Instance** | One running process: one bot, one owner, multiple workspaces. | Process-level |

**Bot ≠ Agent.** A bot is a platform identity. An agent is defined by what's in the workspace's `cwd` — same bot, different cwd, different agent behavior. ClearClaw doesn't model agents. It routes messages to engines pointed at workspaces, and the engine picks up whatever configuration is in that directory.

**Multi-bot = multi-instance.** Separate bots, owners, or teams run separate ClearClaw processes with separate `CLEARCLAW_HOME` directories. No in-process multi-bot routing needed.

## Workspace Model

A **workspace** is a named unit defined by a working directory (CWD).

- **Home workspace** (`default`): The bot's home — personal assistant context for general questions, life management, system tasks. Lives at `~/.clearclaw/workspace/` (singular). Has its own `CLAUDE.md`, identity files, memory, skills. DM chat routes here.
- **Project workspaces** (user-defined, e.g., `myapp`, `work-api`): CWD is any directory on the machine (e.g., `~/projects/myapp`). The agent runs there with full access to the codebase. The project's own `CLAUDE.md` and `.claude/settings.json` apply naturally — same as a terminal session. Each project workspace maps to a Telegram group.

**Why singular `workspace/`, not `workspaces/default/`?** Project workspaces don't need a ClearClaw-managed directory — they point to existing repos. The only workspace that needs a managed home is the personal one, and there's only ever one (one bot, one user, one DM). Multiple identities would mean multiple bot deployments, not multiple directories. Keeping it singular also gives a clean mental model: the bot has a home (`workspace/`) and visits projects (external repos).

Each workspace is a row in SQLite:

| Field | Description |
|-------|-------------|
| `name` | Unique identifier (e.g., `default`, `myapp`) |
| `cwd` | Absolute path to working directory |
| `session_id` | Current Claude Code session ID |
| `chat_id` | The chat (Telegram group, DM, Slack channel, etc.) mapped to this workspace |

## File Structure

```
src/
  index.ts              # Entry point, orchestrator wiring, starts bot
  orchestrator.ts       # Message routing, turn management
  types.ts              # Channel, Engine, Workspace, event types
  config.ts             # Env vars → typed config object
  db.ts                 # SQLite: workspaces table
  format.ts             # Message formatting (tool descriptions, diffs)
  engine/
    claude-code.ts      # Claude Code SDK wrapper
  channel/
    telegram.ts         # grammY Telegram bot
```

## Data Flow

```
Telegram message
  → TelegramChannel emits "message" event
  → Orchestrator.handleMessage()
  → looks up workspace by chat_id
  → ClaudeCodeEngine.runTurn()
  → SDK query() with prompt, CWD, optional resume
  → SDK yields SDKMessages (assistant text, tool calls, result)
  → Engine yields EngineEvents (text, tool_use, tool_result, done, error)
  → Orchestrator accumulates text, sends intermediate chunks
  → TelegramChannel.sendMessage()
```

## Permission Flow

```
SDK calls canUseTool(toolName, input)
  → Engine calls onPermissionRequest callback
  → Orchestrator calls TelegramChannel.sendInteractive()
  → User taps Allow/Deny inline button
  → Promise resolves with button value
  → Engine returns PermissionResult to SDK
```

Permission modes are relayed, not owned:

| Mode | Behavior |
|------|----------|
| `default` | Each tool use → chat buttons (Allow / Deny) |
| `acceptEdits` | Auto-approves file edits, asks for everything else |
| `plan` | Plan summary → Approve/Reject buttons |
| `bypassPermissions` | All tools auto-approved, no relay needed |

Permission config is also native — the CLI loads `settings.json` hierarchically (`~/.claude/settings.json` → `{cwd}/.claude/settings.json` → `{cwd}/.claude/settings.local.json`). The relay doesn't touch these.

## Session Management

Sessions are scoped to workspace (CWD), not channel.

Claude Code stores sessions at `~/.claude/projects/{encoded-cwd-path}/sessions/`. We store the active `session_id` per workspace in SQLite.

- **Terminal-mobile handoff:** A terminal session and a mobile session for the same CWD share the same session store. Start in the terminal, continue via Telegram, pick it back up in the terminal.
- **Session commands:** `/new` clears the stored session ID. Default behavior is resume.
- **Turn isolation:** One message at a time per workspace. Concurrent turns across different workspaces are allowed.

## Key Interfaces

Defined in `src/types.ts`. Two interfaces keep the orchestrator decoupled from specific channels and engines:

- **Channel** — EventEmitter. `connect`/`disconnect`, `sendMessage`, `sendInteractive` (buttons), `setTyping`. Emits `"message"` events. Each channel owns a prefix namespace (`tg:`, `slack:`) and implements `ownsId()` for routing.
- **Engine** — `runTurn()` returns `AsyncIterable<EngineEvent>`. The orchestrator iterates events and routes them to the channel.
- **Workspace** — `name`, `cwd`, `chat_id`, `current_session_id`

## Storage

- `~/.clearclaw/workspace/` — The bot's home (identity, memory, skills, CLAUDE.md). Singular — only the personal/default workspace lives here; project workspaces point to existing repos.
- `~/.clearclaw/clearclaw.db` — SQLite: workspaces table (routing: chat → cwd + session)
- `~/.clearclaw/clearclaw.log` — Daemon log (console + file dual output)
- `~/.claude/projects/...` — Session data (owned by Claude Code, not us)

## Config

Environment variables:
- `TELEGRAM_BOT_TOKEN` (required)
- `ALLOWED_USER_ID` (required) — platform user ID of the owner (trust boundary)
- `PERMISSION_MODE` (optional, defaults to `default`)
- `CLEARCLAW_HOME` (optional, defaults to `~/.clearclaw`) — data directory for DB, logs. Use separate values for multi-instance isolation.
