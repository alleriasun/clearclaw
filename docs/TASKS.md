# ClearClaw — Task Backlog

## Phase 1 Improvements

- [ ] Message queue (queue messages during active turn, drain after) — prerequisite for multi-user
- [ ] Stale detection (JSONL file size comparison before each turn)
- [ ] Turn locking (proper mutex, not just busy flag)
- [ ] Session-scoped permission allowlists ("Allow X for session")
- [x] Message splitting for 4096 char limit
- [x] Tool use status messages (show which tools are being called)
- [x] Relay tool outputs (SDK `user` messages with tool results are currently skipped — bash output, file contents, etc. not visible to user)
- [x] Text accumulation/batching (send intermediate chunks)
- [ ] `/cancel` command (abort current turn)
- [ ] `/status` command (show current session info)
- [ ] `/help` command
- [ ] Graceful shutdown with deferred cleanup
- [ ] AskUserQuestion relay (multi-option menus, not just Allow/Deny)
- [ ] Plan mode relay (plan summary + Approve/Reject buttons)
- [x] Refactor Channel to EventEmitter pattern (remove constructor callback injection, channel emits events, orchestrator subscribes)
- [x] Extract orchestrator from index.ts into `src/orchestrator.ts`
- [x] Move `formatToolDescription` from `claude-code.ts` into `format.ts` (cross-engine formatting concern)
- [x] File logger to `~/.clearclaw/clearclaw.log` (dual output: console + file)
- [x] Resilient dev server (nodemon + `tsc --noEmit` gate, 5s debounce)
- [ ] Restart heartbeat (on startup, auto-send resume prompt into existing session or greeting for new sessions, so the bot continues without a manual poke)
- [ ] Shell escape commands (`!git status`, `!ls`) — run shell commands directly from chat without going through the engine
- [ ] Voice input via Telegram (receive voice messages, use STT to transcribe, feed as text prompt — Claude Code SDK may support STT natively)
- [ ] Fix MarkdownV2 formatting for tool_use/tool_result messages (21 warns in logs — escaping looks correct but formatted strings likely double-escape backticks meant as syntax)
- [ ] Add debug approaches to CLAUDE.md (log locations, dev server usage)
- [ ] Show TodoWrite/Read result to user in Telegram
- [x] Merge DESIGN.md into ARCHITECTURE.md + phase-1.md (DESIGN.md deleted)
- [ ] Remove numeric ID assumption — validate/support chat_id prefixes (tg:, slack:) properly across Channel implementations

## Phase 2: Multi-workspace

- [x] Multiple workspaces (each mapped to a chat/group)
- [x] DM → default workspace, project workspaces in dedicated groups
- [ ] Workspace onboarding from chat — send a message from a new group, bot detects unmapped chat and offers to configure it as a workspace (name, cwd) via inline prompts. Replaces manual chat ID extraction from logs + SQL insert.
- [ ] `/workspace` command to switch contexts
- [ ] Workspace management commands (create, delete, list)
- [ ] Per-workspace `extraArgs` for SDK (settings, mcp-config, auth). SDK supports `query({ options: { extraArgs: { settings: "...", "mcp-config": "..." } } })`. Each workspace carries its own CLI overrides so different workspaces can use different API providers or settings.
- [ ] Multi-user support (`ALLOWED_USER_IDS` comma-separated list, multiple users in a group chat). Depends on message queue — without it, one user's turn blocks everyone else.

## Phase 3: Multi-engine (Kiro)

- [ ] Kiro CLI engine implementation
- [ ] Engine selection per workspace
- [ ] JSON-RPC session management

## Phase 4: Slack channel

- [ ] Slack channel implementation (Socket Mode)
- [ ] Block Kit button formatting for permissions
- [ ] mrkdwn formatting

## Phase 5: Scheduler

- [ ] Scheduled tasks (cron-style)
- [ ] Task persistence (JSON or SQLite)

## Future / Parking Lot

- [ ] Make `defaultPromptPath` engine-agnostic — currently hardcodes `CLAUDE.md` in config, which is Claude-specific. When multi-engine support lands (Phase 3), the prompt filename should come from the engine, not config.
- [ ] Config file format (YAML or TOML) — env vars suffice for now, revisit when config grows
- [ ] Semantic memory (vector search, decay/relevance) — flat CLAUDE.md/MEMORY.md suffice for now. Options: embed-based search over memory files, OpenMemory integration, or keep flat files with better organization. Needs a design decision.
