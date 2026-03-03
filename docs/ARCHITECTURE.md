# ClearClaw — Architecture

Transparent relay between chat channels and CLI agents. See [DESIGN.md](DESIGN.md) for rationale.

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
- **Workspace** — name, cwd, channel_id, current_session_id

## Storage

- `~/.clearclaw/clearclaw.db` — SQLite: workspaces table
- `~/.claude/projects/...` — Session data (owned by Claude Code, not us)

## Config

Environment variables:
- `TELEGRAM_BOT_TOKEN` (required)
- `ALLOWED_CHAT_ID` (required)
- `DEFAULT_CWD` (optional, defaults to `$HOME`)
- `PERMISSION_MODE` (optional, defaults to `default`)
