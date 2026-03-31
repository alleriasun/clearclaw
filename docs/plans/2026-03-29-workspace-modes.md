# Workspace Modes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `behavior` to workspaces so home workspaces get message batching, silent participation tools, and display filtering; project workspaces keep existing relay behavior unchanged.

**Architecture:** `behavior` is an optional field on `Workspace` — stored only when explicitly overridden via `/behavior`. Effective behavior is derived at runtime: `ws.behavior ?? (isHomeWorkspace ? "assistant" : "relay")`. Both behaviors use the same message queue; relay drains immediately, assistant debounces (~1s). Display and permission logic branch on resolved behavior inside `routeEngineEvent`.

**Tech Stack:** TypeScript (NodeNext ESM), grammY 1.30 (Telegram), @slack/bolt 4.6 (Slack), @anthropic-ai/claude-agent-sdk 0.2.x (MCP via `createSdkMcpServer`/`tool`), zod.

**Spec:** `docs/specs/2026-03-29-workspace-modes.md`

---

## File Map

| File | Change |
|------|--------|
| `src/types.ts` | `behavior?` on `Workspace`; `reactToMessage` on `Channel`; `replyToMessageId` on `SendMessageOpts` |
| `src/workspace-store.ts` | Add `setBehavior()` |
| `src/channel/telegram.ts` | `reactToMessage`; `replyToMessageId` on first chunk of `sendMessage` |
| `src/channel/slack.ts` | `reactToMessage` with emoji map; `replyToMessageId` via `thread_ts` |
| `src/orchestrator.ts` | Queue infrastructure; `/behavior` command; `effectiveBehavior`; `enqueueMessage`; `drainAndRun`; `scheduleDebounce`; `executeTurn`; `buildMcpTools`; `handlePermission`; updated `routeEngineEvent` |

No new files needed.

---

## Chunk 1: Schema + Storage

### Task 1: `src/types.ts`
- [ ] Add `replyToMessageId?: string` to `SendMessageOpts`
- [ ] Add `reactToMessage(chatId, messageId, emoji): Promise<void>` to `Channel` (after `sendFile`)
- [ ] Add `behavior?: "assistant" | "relay"` to `Workspace` (optional — defaults derived from cwd at runtime)
- [ ] `npm run check`

### Task 2: `src/workspace-store.ts`
- [ ] Add `setBehavior(name, behavior)` method (same pattern as `setSession`)
- [ ] `npm run check`

---

## Chunk 2: Channel Implementations

### Task 3: `src/channel/telegram.ts`
- [ ] Update `sendMessage`: track `firstChunk` boolean; pass `reply_parameters: { message_id: Number(opts.replyToMessageId) }` on first chunk only — both normal send and plain-text retry. Only first chunk gets the visual quote header.
- [ ] Add `reactToMessage`: `bot.api.setMessageReaction(numId, Number(messageId), [{ type: "emoji" as const, emoji: emoji as any }])` — catch+warn on error. `emoji as any` because grammY restricts to a specific emoji union but Telegram handles unknown emoji gracefully.
- [ ] `npm run check`

### Task 4: `src/channel/slack.ts`
- [ ] Add `private static readonly EMOJI_TO_SLACK: Record<string, string>` (16 common emoji → Slack name)
- [ ] Add `reactToMessage`: look up name in map; warn+return if missing; `app.client.reactions.add` — catch+warn
- [ ] Update `sendMessage`: if `replyToMessageId` set, skip typing consumption (can't edit into a thread); pass `thread_ts` on all chunks (Slack requires it on every message to stay in thread)
- [ ] `npm run check`

---

## Chunk 3: Orchestrator

### Task 5: ChatState + queue + /behavior command

- [ ] Add to `ChatState`: `messageQueue: InboundMessage[]`, `debounceTimer: ReturnType<typeof setTimeout> | null`; initialize to `[]`/`null` in `chat()`
- [ ] Hoist workspace lookup (`const ws = this.workspaceStore.byChat(msg.chatId)`) before all command handlers to eliminate duplicate per-command lookups
- [ ] Add `/behavior` command (after `/cancel`): reads `effectiveBehavior(ws)` → interactive button selection (✓ marks current) → `setBehavior` → `updateStatusMessage`
- [ ] Replace old busy-check + inline turn block with `this.enqueueMessage(msg, ws, state)`

### Task 6: Core queue methods

- [ ] `effectiveBehavior(ws)`: return `ws.behavior` if set; else `ws.cwd === path.dirname(this.defaultPromptPath) ? "assistant" : "relay"`
- [ ] `enqueueMessage(msg, ws, state)`: push to queue; if busy return (post-turn drain handles it); relay → `drainAndRun()`; assistant → `clearTimeout` + `scheduleDebounce()`
- [ ] `scheduleDebounce(chatId)`: 1s timer → `drainAndRun()`
- [ ] `drainAndRun(chatId)`: guard (empty/busy); snapshot+clear queue; `executeTurn`; catch→send error; post-turn drain: relay → `drainAndRun()`; assistant → `scheduleDebounce()`
- [ ] `executeTurn(chatId, messages, ws, state)`: set busy/abort/typing; resolve `behavior = effectiveBehavior(ws)`; `isHomeWorkspace = cwd === path.dirname(defaultPromptPath)`; build prompt via `buildPrompt(messages)`; save attachments; create MCP server; `engine.runTurn` with `permissionMode: state.permissionMode ?? (behavior === "assistant" ? "bypassPermissions" : this.permissionMode)`; route events; finally: clear busy/abort, skip `setTyping(false)` if `staySilent`, send "Turn cancelled." if aborted

### Task 7: MCP tools, permissions, routing, helpers

- [ ] `buildMcpTools(chatId, behavior, turnState)`: always `send_file`; if assistant also add `stay_silent` (set flag + `setTyping(false)`), `react` (→ `reactToMessage`), `reply_to` (set `turnState.replyToMessageId`)
- [ ] `handlePermission(req, chatId)`: `mcp__clearclaw__*` → auto-allow; custom handlers (`permissionHandlers`); default: `formatPermissionPrompt` for all (no behavior-specific prompt)
- [ ] Update `routeEngineEvent(chatId, event, workspaceName, behavior, turnState)`:
  - `text`: if `staySilent` break; else send with `replyToMessageId: turnState.replyToMessageId ?? undefined`
  - `tool_use`: if assistant break; relay keeps existing display logic (TodoWrite, EnterPlanMode, rolling status)
  - `done`: tool summary in relay only; update status in both
- [ ] Add `buildPrompt(messages)` helper: `[msg:N] sender: text` format, one line per message, with reply context prefix and attachment note
- [ ] `npm run check` — expect clean

---

## Chunk 4: Verification

- [ ] `npm run check` — 0 errors
- [ ] `npm run build` — succeeds

---

## Key Design Notes

- `behavior?` optional in `Workspace` — no migration needed; absent entries resolve via `effectiveBehavior()`
- `effectiveBehavior(ws)` is the single source of truth for resolved behavior
- Unified queue for both behaviors — drain timing is the only difference (immediate vs debounced)
- Single `buildPrompt()` format: `[msg:N] sender: text` for relay and assistant alike
- Assistant default: `bypassPermissions` (yolo for now; auto mode coming)
- `stay_silent` calls `setTyping(false)` immediately; `finally` skips if already cleared
- Slack `reactToMessage`: emoji map; silent skip for unknown emoji
- Slack `replyToMessageId`: skips typing consumption; `thread_ts` on all chunks
- Telegram `reactToMessage`: `setMessageReaction` (Bot API 7.0+, grammY 1.21+); `emoji as any` — grammY types restrict to specific emoji union
