# ClearClaw

Transparent relay daemon: chat channels (Telegram, Slack) ↔ Claude Code CLI. Routes interactions without duplicating CLI functionality.

## Quick Reference

```bash
npm start          # Run (requires env vars)
npm run dev        # Local dev (tsx --watch, auto-restarts)
npm run dev:relay  # Remote dev (nodemon watches dist/, explicit build)
npm run build      # tsc → dist/ (triggers dev:relay restart)
npm run check      # tsc --noEmit (type check only)
```

**Required env vars:** Channel token(s) + `ALLOWED_USER_IDS` (comma-separated, channel-prefixed, e.g. `tg:12345,slack:U67890`)
**Channel:** `TELEGRAM_BOT_TOKEN` for Telegram, or `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` for Slack (one channel at a time; Slack takes priority if both are set)
**Optional:** `PERMISSION_MODE` (default|acceptEdits|bypassPermissions|plan|dontAsk), `CLEARCLAW_HOME` (defaults to `~/.clearclaw`)

## Dev Server

**`npm run dev`** — standard local development. `tsx --watch` runs TypeScript directly, restarts on file changes. Use this when developing from desktop with a terminal.

**`npm run dev:relay`** — remote development via Telegram. `nodemon` watches `dist/` and restarts only when `npm run build` produces new output. Builds are explicit, not automatic. This is critical for ClearClaw-through-ClearClaw development where edits are approved one at a time over unpredictable intervals — an auto-rebuilding watcher would restart the server mid-batch, killing the Telegram connection.

## Conventions

- All imports use `.js` extension (required by NodeNext module resolution, even for `.ts` source files)
- Interfaces defined in `types.ts`, implementations in their own files
- Data types use `interface`/`type` + plain objects. Classes only for Channel and Engine implementations
- ClearClaw is a relay, not an agent frontend. It does NOT own permissions, tool allowlists, MCP config, memory, or system prompts — the CLI owns all of those. When in doubt about where logic belongs: in the CLI, not here.
- For changes with meaningful complexity, persist the design/implementation plan in `docs/plans/YYYY-MM-DD-<slug>.md`. Write it as a full story — context, research, decisions with tradeoffs explored, not just file-level changes.

## Docs

- `docs/ARCHITECTURE.md` — Concepts, file structure, data/permission flows, interfaces, storage, config
- `docs/TASKS.md` — Backlog (phased). Check this first when asked about tasks, the backlog, or what's on the list. Update it when a task is completed or its status changes.
- `docs/OVERVIEW.md` — Strategy, rationale, what ClearClaw is and isn't
- `docs/plans/` — Design/implementation plans for complex changes
