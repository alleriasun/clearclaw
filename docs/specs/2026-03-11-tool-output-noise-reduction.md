# Plan: Reduce Telegram noise — rolling tool message, inline diffs, result suppression

## Context

Tool output in Telegram was too verbose:
1. Each tool call sent a separate message — 15 reads = 15 messages
2. Tool results (WebFetch, WebSearch, Bash, etc.) shown even though Claude summarizes in text
3. Edit/Write diffs disconnected from permission prompts — no visual association

## Design Decisions

### Tool call display: batching → rolling single line

**First approach:** Batch consecutive tool calls into a growing list message, edited as new calls arrive.

**Problem:** Solves message count but not length — 20 tools = long noisy list. Also needs flush logic (when to break the batch for text/permission events) adding orchestrator complexity.

**Pivot:** Single rolling message. Each tool_use replaces previous content entirely — only the current tool shown (`🔧 Read: src/config.ts`), truncated to ~60 chars. Turn-end summary shows per-tool counts derived from engine's `toolUseIdToName` map (e.g., `🔧 3× Read, 2× Grep, 1× Bash`).

Spinner (periodic re-edits with rotating Braille chars) considered for activity indication between tool events. Deferred — complexity (interval timers, Telegram rate limit handling) for marginal benefit. Typing indicator covers gaps.

### Tool results: allowlist → full suppression

**First approach:** Flip from blocklist to allowlist — only show Bash output, since Bash has side effects and its output is "the thing that happened" (build logs, test results).

**Feedback:** What's the case for showing Bash at all? The optimal UX is on-demand expansion (like Ctrl+O in Claude Code CLI) but that's too complex for now.

**Pivot:** Suppress everything. Engine yields `tool_result` events but orchestrator discards them. Agent text summary is the user-facing output. On-demand result expansion is future work.

### Permission-diff linking: reply_to → inline

**First approach:** Send Edit/Write diffs as standalone messages, then link the permission prompt via Telegram's `reply_to_message_id`. Store diff message handles in a `pendingEditHandles` queue on ChatState, pop when permission request arrives.

**Problem:** Matching depends on order — fragile with parallel tool calls arriving out of sequence.

**Pivot:** Put the diff directly in the permission prompt message. One self-contained message: header + MarkdownV2 code block with unified diff + Allow/Deny buttons. No linking, no queue, no ordering dependency. `sendInteractive` gained `parseMode` support with automatic plain-text fallback (MarkdownV2 is brittle).

### Permission prompt formatting

All tools now get consistent `🔐 Allow {Tool}?` header. Edit gets unified diff, Write gets file preview, everything else gets key detail in code block (command/pattern/query/URL). Unknown tools fall back to JSON-serialized input.

Buttons: `[👍 Allow] [👎 Deny]` / `[📝 Deny + Note]`. Allow+Note considered but deferred — SDK's allow `PermissionResult` has no message channel (`{ behavior: "allow", updatedInput }` only).

### Plumbing

- **MarkdownV2 escaping:** Single `escapeMarkdownV2(text, codeBlock?)` — different rules inside vs outside code blocks (inside: only backtick + backslash; outside: 21 special chars)
- **toolUseId threading:** SDK tool_use `id` threaded through EngineEvent and PermissionRequest for stable matching. Also powers `toolUseIdToName` map for turn-end stats.
- **Deny+Note:** Follow-up prompt ("Add your feedback:") replies to the permission message via `reply_parameters`

## Files

- `src/format.ts` — formatToolStatusLine, formatToolCallSummary, formatPermissionPrompt, formatToolDetail, escapeMarkdownV2
- `src/orchestrator.ts` — Rolling toolCallHandle, turn-end summary, permission prompts, button layout, result suppression
- `src/types.ts` — SendInteractiveOpts.parseMode, toolUseId on events, TurnStats.toolCalls
- `src/engine/claude-code.ts` — Thread toolUseId, retain toolUseIdToName for stats, per-tool counts
- `src/channel/telegram.ts` — parseMode with fallback, deny+note reply linking, feedback prompt
