# Custom Tool Interaction Handlers

**Date:** 2026-03-28
**Status:** Design

---

## Context

ClearClaw's permission handler is monolithic. Every tool through `canUseTool` gets the same treatment: `formatPermissionPrompt()` renders display, orchestrator shows Allow/Deny/Deny+Note, response maps to `allow`/`deny`.

This works for standard tools (Bash, Edit, Write) but several built-in SDK tools need different interaction patterns:

- **AskUserQuestion** — dumps raw JSON. Should show formatted question + option buttons, relay answer.
- **ExitPlanMode** — dumps raw JSON of plan. Should render plan, offer Approve/Reject.
- **EnterPlanMode** — shouldn't prompt. CLI just enters plan mode.
- **TodoWrite** — auto-allowed, invisible. Status flicker gets overwritten. No visibility into task state.

The permission prompt is a **tuple of (format, buttons, response handler)** but only format is customizable today.

### Research: SDK mechanisms

**AskUserQuestion** goes through `canUseTool`. The SDK's official pattern ([docs](https://platform.claude.com/docs/en/agent-sdk/user-input)) is to detect `toolName === "AskUserQuestion"`, collect answers, and return `allow` with `updatedInput` containing an `answers` object:

```typescript
{ behavior: "allow", updatedInput: { questions: input.questions, answers: { "question text": "selected label" } } }
```

The SDK's built-in handler reads `answers` from `updatedInput` and produces a tool result the model reads. This is special — for regular tools, `updatedInput` only affects execution ("Claude sees the result but isn't told you changed anything"). For AskUserQuestion, the modified input IS the mechanism.

**`updatedInput` for regular tools** does not communicate back to the model. A `_userNote` field on Bash input would be ignored by the shell and invisible to the model. "Allow with note" needs streaming input (follow-up user message after allow), which ClearClaw doesn't support yet. → Backlog.

**EnterPlanMode** — may not exist as a tool in the SDK. The SDK has `ExitPlanModeInput` but no `EnterPlanModeInput`. Plan mode entry might be handled internally via `set_permission_mode` control request. Needs empirical verification. If it does hit `canUseTool`, auto-allow + notify. If not, skip.

**ExitPlanMode** goes through `canUseTool`. The SDK's `ExitPlanModeInput` contains `allowedPrompts` (permission prompts for implementation), not the plan text. The plan text may arrive via the `description` field or in the catch-all `[k: string]: unknown`. Needs empirical verification of what's actually in the input.

**TodoWrite** is auto-allowed, never triggers `canUseTool`. Only appears as `tool_use` events.

---

## Design

### Architecture: handler map

Two handler maps, one per interception point.

**Permission handlers** — keyed by tool name, looked up in `onPermissionRequest`:

```typescript
interface ToolPromptResult {
  text: string;              // formatted message body
  buttons: Button[][];       // button layout
  mapResponse: (resp: ButtonResponse) => PermissionResponse;
}
type ToolPromptHandler = (toolName: string, input: Record<string, unknown>, description: string) => ToolPromptResult | null;
```

Orchestrator checks `permissionHandlers.get(toolName)`. If found and non-null, uses handler's tuple. If `null`, orchestrator handles directly (auto-allow + optional side effects like sending a notification). Falls through to current default for unregistered tools.

**Critical plumbing change:** `PermissionResponse` must gain `updatedInput?: Record<string, unknown>`, and `claude-code.ts` must use `resp.updatedInput ?? input` when building the SDK's `PermissionResult`. Without this, AskUserQuestion answers cannot reach the SDK.

**Display handlers** — keyed by tool name, looked up in `routeEngineEvent` `tool_use` case:

```typescript
type ToolDisplayHandler = (input: Record<string, unknown>, chatId: string, state: ChatState) => Promise<void>;
```

Checked before the default rolling status line.

### Tool: AskUserQuestion

**Interception:** Permission handler.

**Rendering:** First question only (SDK supports 1-4, single is common). Header + question + numbered options with descriptions.

```
❓ Architecture
Which approach for MCP server creation?

1. Approach 3 (Recommended) — Factory in src/mcp/server.ts...
2. Approach 1 — Same flow but inline...
3. Approach 2 — Engine creates the MCP server...
```

**Buttons:** One row per option (label truncated to Telegram limits), plus "Other..." with `requestText: true`.

**Response:** Option button → `allow` with `updatedInput: { questions, answers: { questionText: selectedLabel } }`. "Other..." → answer value is the user's typed text (not the word "Other"). No timeout (matches CLI behavior — `sendInteractive` blocks until answered).

**Button labels:** Truncate to 45 chars (matching `MAX_BTN` from `/resume`). Format: `"1. Label text"` truncated.

**Multi-select:** Initial implementation treats as single-select. True multi-select is a follow-up.

### Tool: ExitPlanMode

**Interception:** Permission handler.

**Rendering:** Render whatever's available from input. The SDK's `ExitPlanModeInput` has `allowedPrompts` and a catch-all `[k: string]: unknown` — plan text may be in an extra field or in the `description` parameter. Empirical verification needed. Truncated if too long.

```
📋 Plan Review

# In-Process MCP Server — send_media
...plan content or allowedPrompts summary...
```

**Buttons:** `[✅ Approve] [❌ Reject]` and `[📝 Reject + Note]`.

**Response:** Approve → `allow` with `updatedInput: input`. Reject → `deny` with "User rejected the plan". Reject + Note → `deny` with user's feedback.

### Tool: EnterPlanMode

**Status:** Uncertain — may not go through `canUseTool` at all (no `EnterPlanModeInput` in SDK types). Needs empirical verification.

**If it does hit canUseTool:** Permission handler returns `null`. Orchestrator sends notification "📋 Entering plan mode" and returns `allow` immediately. The orchestrator handles the side-effect (channel.sendMessage) directly since `null`-returning handlers can't carry channel context.

### Tool: TodoWrite (display only)

**Interception:** Display handler in `routeEngineEvent`.

**Rendering:** Compact task list, edited in place via rolling message.

```
📋 Tasks
✅ Explore codebase
⏳ Asking questions
⬚ Write spec
```

Uses `activeForm` for in-progress items (present tense), `content` for completed/pending.

**State:** New `todoHandle: string | null` on `ChatState`. First TodoWrite creates message, subsequent ones edit it. Only updates when content changed (compare serialized todos).

**Lifecycle:** Reset `todoHandle` to `null` at turn end (same as `toolCallHandle`). Each turn gets a fresh task list message. An old message buried in chat history is useless — better to create a new one each turn.

**Rolling status suppression:** TodoWrite `tool_use` events should NOT update the rolling tool status line. The display handler replaces the default behavior entirely.

### Rolling status suppression

Tools with permission handlers (AskUserQuestion, ExitPlanMode) also emit `tool_use` events that hit `routeEngineEvent` before `canUseTool` fires. Without suppression, users see a brief "🔧 AskUserQuestion" flicker before the formatted question appears. Add these tools to the display handler map with a no-op handler that skips the rolling status update.

### Default handler (unchanged)

All tools not in the handler maps get current behavior: `formatPermissionPrompt()` + Allow/Deny/Deny+Note.

---

## File changes

| File | Change |
|------|--------|
| `src/tool-handlers.ts` (new) | Export `permissionHandlers` and `displayHandlers` maps. Handler functions + response mappers. |
| `src/format.ts` | Add `formatAskUserQuestion()`, `formatExitPlanMode()`, `formatTodoList()`. Existing functions unchanged. |
| `src/orchestrator.ts` | Import handler maps. `onPermissionRequest`: lookup before default. `routeEngineEvent` tool_use: lookup display handler before status line. Add `todoHandle` to `ChatState`. |
| `src/types.ts` | Add `updatedInput?` to `PermissionResponse`. Add `ToolPromptResult`, `ToolPromptHandler`, `ToolDisplayHandler`. |
| `src/engine/claude-code.ts` | Use `resp.updatedInput ?? input` in the allow path (line 84). |

---

## Backlog (not this iteration)

- **Allow + Note for regular tools** — needs streaming input support
- **Multi-question AskUserQuestion** — handle all questions, not just first
- **AskUserQuestion multi-select** — proper multi-select with confirm step
- **ExitPlanMode mode switching** — CLI offers mode switch options alongside plan approval
