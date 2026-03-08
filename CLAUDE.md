# ClearClaw

Transparent relay daemon: Telegram ↔ Claude Code CLI. Routes interactions without duplicating CLI functionality.

## Quick Reference

```bash
npm start          # Run (requires env vars)
npm run dev        # Run with --watch
npm run build      # tsc → dist/
npm run check      # tsc --noEmit (type check only)
```

**Required env vars:** `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_ID`
**Optional:** `PERMISSION_MODE` (default|acceptEdits|bypassPermissions|plan|dontAsk), `CLEARCLAW_HOME` (defaults to `~/.clearclaw`)

## Code Layout

```
src/
  index.ts              # Entry point, wiring
  orchestrator.ts       # Message routing, turn management
  types.ts              # Channel, Engine, Workspace interfaces
  config.ts             # Env → typed config
  db.ts                 # SQLite (better-sqlite3)
  engine/claude-code.ts # Claude Agent SDK wrapper
  channel/telegram.ts   # grammY bot
```

Seven files. No build step needed for dev (`tsx` runs TS directly).

## Stack

- **Runtime:** Node + tsx (ES modules, `"type": "module"`)
- **TypeScript:** ES2022 target, NodeNext modules, strict mode
- **SDK:** `@anthropic-ai/claude-agent-sdk` — `query()` returns `AsyncGenerator<SDKMessage>`
- **Telegram:** grammY — `InlineKeyboard`, `bot.on("callback_query:data")`
- **DB:** better-sqlite3 at `~/.clearclaw/clearclaw.db`

## Conventions

- All imports use `.js` extension (required by NodeNext module resolution, even for `.ts` source files)
- Interfaces defined in `types.ts`, implementations in their own files
- Data types use `interface`/`type` + plain objects. Classes only for Channel and Engine implementations

## Design Constraint

ClearClaw is a relay, not an agent frontend. It does NOT own permissions, tool allowlists, MCP config, memory, or system prompts — the CLI owns all of those. When in doubt about where logic belongs: in the CLI, not here.

## Docs

- `docs/OVERVIEW.md` — Strategy, rationale, what ClearClaw is and isn't
- `docs/ARCHITECTURE.md` — Concepts, workspace model, data/permission flows, interfaces, storage
- `docs/TASKS.md` — Backlog (phased)
