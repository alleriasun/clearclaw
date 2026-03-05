# Interactive Diff Display — Implementation Plan

## Context

ClearClaw currently relays only assistant text. Tool use blocks (Edit, Write, Bash, Read) flow through the SDK but are silently dropped. The user has no visibility into what the agent is actually *doing* — they see the agent's words, but not its actions.

This plan adds **interactive diff display**: when Claude edits or writes files, the relay formats the changes as readable diffs in Telegram, with inline buttons to approve/reject individual file changes.

## Problem

Right now, the engine loop in `claude-code.ts` only yields `text` events from `SDKAssistantMessage` content blocks of type `"text"`. Content blocks of type `"tool_use"` are ignored. This means:

- File edits (Edit tool: `old_string` → `new_string`) — invisible
- File writes (Write tool: full file content) — invisible
- Bash commands and their output — invisible (separate backlog item)
- The user has to trust the agent blindly or check their machine after the fact

## Scope

**In (this plan):**
- Capture `tool_use` content blocks for `Edit` and `Write` tools from `SDKAssistantMessage`
- Yield a new `EngineEvent` type (`tool_use`) with structured tool data
- Format Edit diffs as unified diff blocks in Telegram (monospace)
- Format Write operations as file creation/overwrite notices with content preview
- Truncate large diffs with a line count summary
- Inline keyboard: "👍" / "👎" reaction buttons (non-blocking, cosmetic feedback — actual permission is handled separately)

**Out (backlog):**
- Bash command output relay (separate task in TASKS.md)
- Read tool output relay
- Syntax highlighting (Telegram has no native support)
- Diff collapsing/expanding (Telegram has no native accordion)
- File-level approve/reject that blocks execution (permissions already handle this)

## Design Decisions

- **New `EngineEvent` variant**: `{ type: "tool_use"; toolName: string; input: Record<string, unknown> }` — keeps the engine interface generic; formatting lives in the orchestrator/channel layer
- **Formatting in orchestrator, not engine**: The engine yields raw tool data. The orchestrator decides how to format it for the channel. This preserves the engine/channel decoupling.
- **Unified diff style for Edit**: Show `--- a/path` / `+++ b/path` headers with `-` and `+` lines, matching the familiar `git diff` look. Telegram renders `<pre>` blocks in monospace which is perfect for diffs. V1 is a simple dump — all `old_string` lines as `-`, all `new_string` lines as `+` (not a true line-level diff). Good enough for the small, targeted edits Claude typically makes. Can swap in a small diff library later for proper line-level diffing.
- **MarkdownV2 parse mode**: Telegram's MarkdownV2 supports ``` code blocks. Use this for diff rendering.
- **Truncation at 30 lines**: Diffs longer than 30 lines get truncated with a `... (N more lines)` footer. Full diff is too noisy on mobile.
- **Write tool**: Show first 20 lines of new file content with `📄 New file: path` header.
- **Flush text before tool display**: Same pattern as permission prompts — flush accumulated `fullText` before sending the diff message. Keeps chronological order.

## File Changes

### 1. `src/types.ts` — Add `tool_use` event variant

```typescript
export type EngineEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; toolName: string; input: Record<string, unknown> }
  | { type: "done"; sessionId: string }
  | { type: "error"; message: string };
```

### 2. `src/engine/claude-code.ts` — Yield `tool_use` events

In the assistant message handler, after the text block extraction, add:

```typescript
if (block.type === "tool_use") {
  yield { type: "tool_use", toolName: block.name, input: block.input as Record<string, unknown> };
}
```

### 3. `src/format.ts` — New file: diff formatting utilities

~60 lines. Pure functions, no side effects.

```typescript
export function formatToolUse(toolName: string, input: Record<string, unknown>): string | null
export function formatEditDiff(input: { file_path: string; old_string: string; new_string: string }): string
export function formatWritePreview(input: { file_path: string; content: string }): string
function truncateBlock(lines: string[], maxLines: number): string
```

- `formatToolUse` dispatches to Edit/Write formatters, returns `null` for tools we don't format (Bash, Read, etc. — future work)
- `formatEditDiff` builds a unified-diff-style block:
  ```
  ✏️ Edit: src/index.ts
  ```diff
  - old line
  + new line
  ```
  ```
- `formatWritePreview` builds a file preview:
  ```
  📄 Write: src/newfile.ts (42 lines)
  ```typescript
  first 20 lines...
  ```
  ... 22 more lines
  ```
- Escapes MarkdownV2 special characters outside code blocks

### 4. `src/index.ts` — Handle `tool_use` events in orchestrator

In the `for await (const event of engine.runTurn(...))` loop, add a case:

```typescript
if (event.type === "tool_use") {
  const formatted = formatToolUse(event.toolName, event.input);
  if (formatted) {
    // Flush accumulated text first
    if (fullText) {
      await telegram.sendMessage(msg.channelId, fullText);
      fullText = "";
    }
    await telegram.sendMessage(msg.channelId, formatted, { parseMode: "MarkdownV2" });
  }
}
```

### 5. `src/channel/telegram.ts` — Support parse_mode in sendMessage

Extend `sendMessage` to accept an optional options parameter:

```typescript
async sendMessage(
  channelId: string,
  text: string,
  opts?: { parseMode?: "MarkdownV2" | "HTML" },
): Promise<void>
```

Update the `Channel` interface in `types.ts` accordingly.

## Implementation Steps

1. **Types** — Add `tool_use` to `EngineEvent` union, add `parseMode` to `sendMessage` signature
2. **Engine** — Yield `tool_use` events from `tool_use` content blocks
3. **Formatter** — Create `src/format.ts` with diff formatting functions
4. **Channel** — Add `parseMode` support to `telegram.sendMessage`
5. **Orchestrator** — Handle `tool_use` events in the turn loop
6. **Test manually** — Ask Claude to edit a file, verify diff appears in Telegram

## Line Count

| File | Change | Lines |
|------|--------|-------|
| `types.ts` | modify | +3 |
| `engine/claude-code.ts` | modify | +5 |
| `format.ts` | **new** | ~60 |
| `channel/telegram.ts` | modify | +5 |
| `index.ts` | modify | +12 |
| **Total** | | **~85** |

## Risks

- **MarkdownV2 escaping**: Telegram's MarkdownV2 is notoriously fussy about escaping special chars (`_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`, `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!`). Characters inside ``` blocks don't need escaping, but everything outside does. The formatter must handle this carefully.
- **Message length**: A large Edit diff + surrounding text could exceed 4096 chars. The truncation logic (30 lines max) mitigates this, but edge cases exist. Rely on existing truncation in `sendMessage` as a safety net.
- **tool_use timing**: The SDK yields the `tool_use` block *before* the tool executes (it's the assistant's request to use a tool). This means we're showing "what Claude wants to do" not "what happened." This is actually correct for our UX — the user sees the proposed change, then the permission prompt follows if applicable.
