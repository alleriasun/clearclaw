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
- [x] Automatic home creation and approved-DM binding, preserving existing identity/runtime settings
- [x] Unified workspace/project creation tools in ordinary workspace conversations; manual chats connect with `/connect`
- [x] Retire conversational onboarding, its prompt, `TaskState`, and `task_complete`; retain pairing and scheduling
- [ ] Proactive prompts on platform events such as joining a group (separate from workspace creation)
- [ ] `/workspace` command to switch contexts
- [ ] Workspace management commands (create, delete, list)
- [ ] Per-workspace `extraArgs` for SDK (settings, mcp-config, auth). SDK supports `query({ options: { extraArgs: { settings: "...", "mcp-config": "..." } } })`. Each workspace carries its own CLI overrides so different workspaces can use different API providers or settings.
- [x] Multi-user support (`ALLOWED_USER_IDS` comma-separated list, multiple users in a group chat)

## Engine Abstraction

- [x] Kiro CLI engine implementation (AcpEngine via `@agentclientprotocol/sdk`)
- [x] Engine selection per workspace (`workspace.engine` field, `workspace_create` tool, native `/engine`)
- [x] JSON-RPC session management (ACP protocol over ndjson stdio)
- [x] Make `defaultPromptPath` engine-agnostic (replaced by prompt assembly: `frameworkPromptDir` + `instructionsDir`)

## Channel Support

- [x] Slack channel implementation (Socket Mode)
- [x] Block Kit button formatting for permissions
- [x] mrkdwn formatting
- [x] Universal markdown in format.ts, channel-specific escaping (MarkdownV2 in telegram.ts, mrkdwn in slack.ts)
- [x] Channel config (env var detection: Slack priority if both set)
- [x] Typing indicator via emoji reactions (👀 on user's message)

## Scheduler

- [x] Scheduled prompts (cron-style, timezone-aware, one-shot support)
- [x] Schedule management via MCP tools (create, list, delete, toggle)
- [x] Bot-initiated turns (proactive prompt primitive for scheduler, housekeeping, events)
- [ ] Idle housekeeping (auto-tidy memory/context during inactivity)
- [ ] `/schedule` command for schedule inspection

## Peer Agents

[Projects and peer spawning](specs/peer-spawning.md) is the maintained lifecycle spec.

- [x] Explicit cross-workspace messaging through `message_workspace`
- [x] Spin-out proposals, automatic spawning, and manual brief claims
- [x] Project creation for new and existing unprojected workspaces
- [x] Telegram topics and Slack private channels with Project grouping
- [x] Explicit directory ownership and ownership-aware archive
- [x] Per-peer engine selection and compatible model inheritance, including manual creation overrides
- [x] [#46: Move worktree preparation out of the creation tool](https://github.com/alleriasun/clearclaw/issues/46), so corporate commands and repository layouts stay in caller tooling
- [ ] Decide and implement shared memory separately; the existing [shared-memory proposal](specs/2026-06-07-peer-agents-and-memory.md#part-2-shared-memory) is not part of the current peer lifecycle

## Agent Situational Awareness

- [ ] Wire `chatType` through Telegram and Slack channels — `chatType` is on `InboundMessage` but not yet populated by either channel
- [ ] Inject message timestamp and current time into each turn — agent has no reliable sense of when it is
- [ ] ChatType context (DM vs group) — surface in turn prompt so agent adjusts tone accordingly
- [ ] Behavior mode context — agent should know whether it's in assistant or relay mode (affects system prompt framing, not just permissions)
- [x] Prompt assembly architecture — framework prompts (`prompts/SYSTEM.md`) bundled in repo, user instructions (`instructions/IDENTITY.md`, `USER.md`, `TOOLS.md`) in home workspace, assembled per-turn by `src/prompt.ts`. Replaces monolithic home workspace CLAUDE.md. `syncSkills()` removed.
- [ ] Session/memory self-management — strategy for when to auto-compact, when to surface memory, when to summarize vs. continue; currently context just grows until it breaks
- [ ] Semantic memory (vector search, decay/relevance) — flat CLAUDE.md/MEMORY.md suffice for now; needs a design decision before building
