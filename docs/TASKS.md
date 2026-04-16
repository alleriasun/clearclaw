# ClearClaw — Task Backlog

## Core Infrastructure

- [x] Message queue (queue messages during active turn, drain after) — prerequisite for multi-user
- [ ] Stale detection (JSONL file size comparison before each turn)
- [ ] Turn locking (proper mutex, not just busy flag)
- [ ] Session-scoped per-tool allowlists ("Allow X for session" button)
- [x] Message splitting for 4096 char limit
- [x] Tool result suppression — engine yields tool_result events, orchestrator discards them (agent summarizes in text)
- [x] Text accumulation/batching (send intermediate chunks)
- [ ] Graceful shutdown with deferred cleanup
- [x] Refactor Channel to EventEmitter pattern (remove constructor callback injection)
- [x] Extract orchestrator from index.ts into `src/orchestrator.ts`
- [x] Move `formatToolDescription` from `claude-code.ts` into `format.ts` (cross-engine formatting concern)
- [x] File logger to `~/.clearclaw/clearclaw.log` (dual output: console + file)
- [x] Resilient dev server (nodemon + `tsc --noEmit` gate, 5s debounce)
- [ ] Restart heartbeat (on startup, auto-send resume prompt into existing session or greeting for new sessions)
- [x] Fix MarkdownV2 formatting for tool_use/tool_result messages (swapped hand-rolled converter for `telegramify-markdown` / `slackify-markdown`)
- [ ] Config file format (YAML or TOML) — env vars suffice for now, revisit when config grows
- [ ] Add debug approaches to CLAUDE.md (log locations, dev server usage)
- [x] Merge DESIGN.md into ARCHITECTURE.md (DESIGN.md deleted)
- [x] Remove numeric ID assumption — validate/support chat_id prefixes (tg:, slack:) properly

## Chat UX & Interactivity

- [x] `/mode` command — per-workspace permission mode switching with pinned status message
- [x] `/cancel` command (abort current turn)
- [x] Permission prompt formatting — 🔐 header, inline diffs for Edit, file preview for Write, code block for other tools
- [x] Permission button UX — 👍/👎 emoji, two-row layout, 📝 Deny + Note with feedback relay
- [x] Tool use status messages — rolling single message updated per tool_use, edited to per-tool summary on turn end
- [x] Reply context — quoted/replied-to message surfaced in turn prompt (Telegram + Slack)
- [x] Custom tool handlers for plan mode and interactive prompts
- [x] Plan mode relay — plan summary + Approve/Reject buttons
- [ ] AskUserQuestion relay (multi-option menus, not just Allow/Deny)
- [ ] `/status` command (show current session info)
- [ ] `/help` command
- [ ] Show TodoWrite updates in chat
- [ ] Voice input via Telegram (receive voice messages, STT transcribe, feed as text prompt)
- [ ] Shell escape commands (`!git status`, `!ls`) — run shell commands directly from chat

## Workspace Management

- [x] Multiple workspaces (each mapped to a chat/group)
- [x] DM → default workspace, project workspaces in dedicated groups
- [x] Workspace modes (assistant/relay behavior) — `/behavior` command, bypassPermissions for assistant, tool status suppression in assistant mode
- [x] Workspace onboarding from chat — setup wizard, auth pairing, auto-workspace creation
  - ⚠️ **Gotcha: Telegram group migration.** When a bot is added as admin to a basic group, Telegram silently migrates it to a supergroup, which changes the chat ID. The old ID stops working immediately. Onboarding flow must handle the `migrate_to_chat_id` update in the Telegram API response and auto-update `workspaces.json` — otherwise the workspace link breaks and you get "No workspace linked to this group." (Learned 2026-03-10.)
  - [x] Chat-based workspace onboarding — model-driven conversational setup when an authorized user messages from an unmapped chat (DM or group). AI-guided flow with task sessions, onboarding skill, workspace MCP tools.
    - [x] Task sessions — ephemeral, scoped sessions tracked in `ChatState.task` (not tied to a workspace's `current_session_id`). Reusable primitive for any short-lived model interaction.
    - [x] Onboarding skill — markdown skill file that guides workspace creation conversationally. Model asks about the project, offers worktree creation, calls `workspace_create` when ready.
    - [x] Workspace MCP tools — `workspace_create` (name, cwd, chat_id) and `worktree_create` (source repo, branch, target path) exposed to the model during task sessions.
  - [ ] Proactive prompts — bot-initiated turns triggered by events (bot added to group, new DM) rather than user messages. Harness injects a system message and kicks off a turn. Builds on task sessions.
- [ ] `/workspace` command to switch contexts
- [ ] Workspace management commands (create, delete, list)
- [ ] Per-workspace `extraArgs` for SDK (settings, mcp-config, auth). SDK supports `query({ options: { extraArgs: { settings: "...", "mcp-config": "..." } } })`. Each workspace carries its own CLI overrides so different workspaces can use different API providers or settings.
- [x] Multi-user support (`ALLOWED_USER_IDS` comma-separated list, multiple users in a group chat)

## Engine Abstraction

- [ ] Kiro CLI engine implementation
- [ ] Engine selection per workspace
- [ ] JSON-RPC session management
- [ ] Make `defaultPromptPath` engine-agnostic — currently hardcodes `CLAUDE.md` in config, which is Claude-specific. When multi-engine support lands, the prompt filename should come from the engine, not config.

## Channel Support

- [x] Slack channel implementation (Socket Mode)
- [x] Block Kit button formatting for permissions
- [x] mrkdwn formatting
- [x] Universal markdown in format.ts, channel-specific escaping (MarkdownV2 in telegram.ts, mrkdwn in slack.ts)
- [x] Channel config (env var detection: Slack priority if both set)
- [x] Typing indicator via emoji reactions (👀 on user's message)

## Scheduler

- [ ] Scheduled tasks (cron-style)
- [ ] Task persistence (JSON or SQLite)

## Agent Situational Awareness

- [ ] Wire `chatType` through Telegram and Slack channels — `chatType` is on `InboundMessage` but not yet populated by either channel
- [ ] Inject message timestamp and current time into each turn — agent has no reliable sense of when it is
- [ ] ChatType context (DM vs group) — surface in turn prompt so agent adjusts tone accordingly
- [ ] Behavior mode context — agent should know whether it's in assistant or relay mode (affects system prompt framing, not just permissions)
- [ ] Session/memory self-management — strategy for when to auto-compact, when to surface memory, when to summarize vs. continue; currently context just grows until it breaks
- [ ] Semantic memory (vector search, decay/relevance) — flat CLAUDE.md/MEMORY.md suffice for now; needs a design decision before building
