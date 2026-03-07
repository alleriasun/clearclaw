# ClearClaw — Architecture

Transparent relay between chat channels and CLI agents. See [DESIGN.md](DESIGN.md) for rationale.

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

## File Structure

```
src/
  index.ts              # Entry point, orchestrator wiring, starts bot
  types.ts              # Channel, Engine, Workspace, event types
  config.ts             # Env vars → typed config object
  db.ts                 # SQLite: workspaces table
  engine/
    claude-code.ts      # Claude Code SDK wrapper
  channel/
    telegram.ts         # grammY Telegram bot
```

## Data Flow

```
Telegram message
  → TelegramChannel.onMessage callback
  → index.ts orchestrator
  → ClaudeCodeEngine.runTurn()
  → SDK query() with prompt, CWD, optional resume
  → SDK yields SDKMessages (assistant text, tool calls, result)
  → Engine yields EngineEvents (text, done, error)
  → Orchestrator accumulates text, sends final response
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

## Key Interfaces

- **Channel** — connect/disconnect, sendMessage, sendInteractive (buttons), setTyping
- **Engine** — runTurn() returns AsyncIterable<EngineEvent>
- **Workspace** — name, cwd, chat_id, current_session_id

## Storage

- `~/.clearclaw/clearclaw.db` — SQLite: workspaces table
- `~/.claude/projects/...` — Session data (owned by Claude Code, not us)

## Config

Environment variables:
- `TELEGRAM_BOT_TOKEN` (required)
- `ALLOWED_USER_ID` (required) — platform user ID of the owner (trust boundary)
- `PERMISSION_MODE` (optional, defaults to `default`)
- `CLEARCLAW_HOME` (optional, defaults to `~/.clearclaw`) — data directory for DB, logs. Use separate values for multi-instance isolation.
