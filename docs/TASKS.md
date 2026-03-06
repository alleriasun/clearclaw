# ClearClaw — Task Backlog

## Phase 1 Improvements

- [ ] Message queue (queue messages during active turn, drain after)
- [ ] Stale detection (JSONL file size comparison before each turn)
- [ ] Turn locking (proper mutex, not just busy flag)
- [ ] Session-scoped permission allowlists ("Allow X for session")
- [ ] Message splitting for 4096 char limit
- [ ] Tool use status messages (show which tools are being called)
- [x] Relay tool outputs (SDK `user` messages with tool results are currently skipped — bash output, file contents, etc. not visible to user)
- [ ] Text accumulation/batching (send intermediate chunks)
- [ ] `/cancel` command (abort current turn)
- [ ] `/status` command (show current session info)
- [ ] `/help` command
- [ ] Graceful shutdown with deferred cleanup
- [ ] AskUserQuestion relay (multi-option menus, not just Allow/Deny)
- [ ] Plan mode relay (plan summary + Approve/Reject buttons)
- [ ] Refactor Channel to EventEmitter pattern (remove constructor callback injection, channel emits events, orchestrator subscribes)
- [ ] Extract orchestrator from index.ts into `src/orchestrator.ts`
- [ ] Move `formatToolDescription` from `claude-code.ts` into `format.ts` (cross-engine formatting concern)
- [x] File logger to `~/.clearclaw/clearclaw.log` (dual output: console + file)
- [x] Resilient dev server (nodemon + `tsc --noEmit` gate, 5s debounce)
- [ ] Restart heartbeat (on startup, auto-send resume prompt into existing session or greeting for new sessions, so the bot continues without a manual poke)

## Phase 2: Multi-workspace

- [ ] Multiple workspaces (each mapped to a channel/group)
- [ ] `/workspace` command to switch contexts
- [ ] Workspace management commands (create, delete, list)
- [ ] Per-workspace `extraArgs` for SDK (settings, mcp-config, auth). SDK supports `query({ options: { extraArgs: { settings: "...", "mcp-config": "..." } } })`. Each workspace carries its own CLI overrides so different workspaces can use different API providers or settings.

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
- [ ] Task persistence in SQLite
