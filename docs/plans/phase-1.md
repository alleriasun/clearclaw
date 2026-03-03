# ClearClaw Phase 1 — Implementation Plan (Minimal First Working Copy)

## Context

Get the simplest possible Telegram ↔ Claude Code relay working on the host. One workspace, one channel, one engine. No frills. Prove the concept, then iterate.

## Naming Decisions

- **`Channel`** not `ChannelAdapter` — simpler
- **`Engine`** not `EngineAdapter` — simpler
- **`Workspace`** not `Context` — it's a CWD + channel mapping, not a chat context. Fields: `name`, `cwd`, `channel_id`, `current_session_id`
- No custom logger — use `console.log`

## File Structure (7 files)

```
src/
  index.ts              # Entry point, wires everything, starts bot
  types.ts              # Channel, Engine, Workspace, event types
  config.ts             # Env vars → typed config object
  db.ts                 # SQLite: workspaces table
  engine/
    claude-code.ts      # Claude Code SDK wrapper
  channel/
    telegram.ts         # grammY Telegram bot
```

## What's In vs Out

**In (this plan):**
- Send a Telegram message → Claude Code processes it → response sent back
- Permission prompts relayed as inline keyboard buttons (Allow / Deny)
- Session persistence across turns (resume via SDK)
- Typing indicator while agent works
- `/new` command to reset session
- Single workspace, single authorized chat

**Out (backlog → TASKS.md):**
- Message queue (messages during active turn)
- Session-scoped permission allowlists ("allow X for session")
- Stale detection (terminal ↔ mobile handoff)
- Turn locking (just reject/ignore during active turn for now)
- Tool use status messages
- Text accumulation/batching
- `/cancel`, `/status`, `/help` commands
- Message splitting for 4096 char limit (truncate for now)
- Graceful shutdown with deferred cleanup

## Implementation Steps

1. **Scaffold** — package.json, tsconfig.json, .gitignore, install deps
2. **Types + Config** — src/types.ts, src/config.ts
3. **SQLite** — src/db.ts with workspaces table
4. **Claude Code engine** — src/engine/claude-code.ts wrapping SDK query()
5. **Telegram channel** — src/channel/telegram.ts with grammY
6. **Wire together** — src/index.ts orchestrator

## Dependencies

- `@anthropic-ai/claude-agent-sdk` — Claude Code SDK
- `better-sqlite3` — SQLite
- `grammy` — Telegram bot framework

## Line Count

| File | Lines |
|------|-------|
| `types.ts` | ~80 |
| `config.ts` | ~55 |
| `db.ts` | ~55 |
| `engine/claude-code.ts` | ~100 |
| `channel/telegram.ts` | ~165 |
| `index.ts` | ~105 |
| **Total** | **~560** |
