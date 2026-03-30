# Add File Logger with pino

## Context
ClearClaw currently uses raw `console.log`/`console.error` calls (18 total across 3 files) with no persistence. The task (from docs/TASKS.md Phase 1) adds structured logging to both console (pretty-printed) and `~/.clearclaw/clearclaw.log` with rotation, using pino.

## Dependencies to install
- `pino` — structured logger
- `pino-pretty` — human-readable console output
- `pino-roll` — file transport with size/time-based rotation

## File changes

### 1. `src/config.ts` — add `logPath()` export
Add a `logPath()` function (mirrors existing `dbPath()`) returning `~/.clearclaw/clearclaw.log`. Uses the existing private `DATA_DIR` constant.

### 2. `src/logger.ts` — new file (~30 lines)
Create the pino logger with two transports:
- **Console**: `pino-pretty` to stdout (level from `LOG_LEVEL` env, default `"info"`)
- **File**: `pino-roll` to `logPath()` with daily rotation, 10 MB size cap, keep 5 old files

Calls `ensureDataDir()` at module load to guarantee `~/.clearclaw/` exists before the file transport opens.

Exports `default log` (pino Logger instance).

### 3. `src/index.ts` — replace 14 console calls
- `import log from "./logger.js"`
- Remove `ensureDataDir()` call from `main()` (logger.ts handles it now)
- `console.log(...)` → `log.info(...)`
- `console.error(...)` → `log.error(...)`
- Keep existing bracket-prefix messages as-is (e.g. `log.info("[turn] done ...")`)

### 4. `src/channel/telegram.ts` — replace 3 console calls
- `import log from "../logger.js"`
- `console.error("[channel] ...")` → `log.error(...)`
- `console.error("Telegram bot error:", ...)` → `log.error(...)`
- `console.log("Telegram bot: @...")` → `log.info(...)`

### 5. `src/engine/claude-code.ts` — replace 1 console call
- `import log from "../logger.js"`
- `console.log("[sdk] ...")` → `log.info(...)`

### 6. `docs/TASKS.md` — check off the task
Mark the file logger task as done: `- [x]`

## Verification
1. `npm run check` — type-check passes
2. `npm run dev` — starts up, console output is pretty-printed, `~/.clearclaw/clearclaw.log` is created with JSON entries
