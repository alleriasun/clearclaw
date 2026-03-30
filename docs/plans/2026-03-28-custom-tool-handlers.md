# Custom Tool Handlers — Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Per-tool custom interaction handlers for AskUserQuestion, ExitPlanMode, EnterPlanMode, and TodoWrite.

**Architecture:** Handler map pattern. Orchestrator dispatches to per-tool handlers before falling through to defaults.

**Spec:** `docs/specs/2026-03-28-custom-tool-handlers.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/types.ts` | Add `updatedInput` to `PermissionResponse`. Export handler type aliases. |
| `src/engine/claude-code.ts` | Pass `updatedInput` through to SDK `PermissionResult`. |
| `src/format.ts` | Pure formatting: `formatAskUserQuestion()`, `formatExitPlanMode()`, `formatTodoList()`. |
| `src/tool-handlers.ts` (new) | Permission + display handler maps. Wires formatters to buttons + response mappers. |
| `src/orchestrator.ts` | Dispatch to handler maps. Add `todoHandle` + lifecycle to `ChatState`. |

---

## Chunk 1: Plumbing — updatedInput through the stack

### Task 1: Add updatedInput to PermissionResponse

**Files:**
- Modify: `src/types.ts:88-91`

- [ ] **Step 1: Add updatedInput field**

In `src/types.ts`, add `updatedInput` to `PermissionResponse`:

```typescript
export interface PermissionResponse {
  decision: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
}
```

- [ ] **Step 2: Type check**: `npm run check`
Expected: PASS (field is optional, no consumers break)

### Task 2: Wire updatedInput through engine

**Files:**
- Modify: `src/engine/claude-code.ts:83-84`

- [ ] **Step 1: Use updatedInput in allow path**

In `src/engine/claude-code.ts`, change line 83-84 from:

```typescript
if (resp.decision === "allow") {
  return { behavior: "allow", updatedInput: input };
}
```

to:

```typescript
if (resp.decision === "allow") {
  return { behavior: "allow", updatedInput: resp.updatedInput ?? input };
}
```

- [ ] **Step 2: Type check**: `npm run check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/types.ts src/engine/claude-code.ts
git commit -m "feat: plumb updatedInput through PermissionResponse to SDK"
```

---

## Chunk 2: Format functions

### Task 3: formatAskUserQuestion

**Files:**
- Modify: `src/format.ts`

- [ ] **Step 1: Add AskUserQuestion formatter**

Add to `src/format.ts` after the existing `formatPermissionPrompt` function:

```typescript
const MAX_BTN = 45;

interface AskUserQuestionOption {
  label: string;
  description: string;
}

interface AskUserQuestionInput {
  questions: {
    question: string;
    header: string;
    options: AskUserQuestionOption[];
    multiSelect: boolean;
  }[];
}

/**
 * Format the first question from an AskUserQuestion tool call.
 * Returns { text, options } where options are the parsed option objects.
 */
export function formatAskUserQuestion(input: Record<string, unknown>): {
  text: string;
  options: AskUserQuestionOption[];
} {
  const { questions } = input as unknown as AskUserQuestionInput;
  const q = questions[0];
  const lines = [`❓ ${q.header}`, q.question, ""];
  for (let i = 0; i < q.options.length; i++) {
    const opt = q.options[i];
    lines.push(`${i + 1}. ${opt.label} — ${opt.description}`);
  }
  return { text: lines.join("\n"), options: q.options };
}

/**
 * Truncate a button label to MAX_BTN chars with number prefix.
 */
export function truncateButtonLabel(index: number, label: string): string {
  const full = `${index + 1}. ${label}`;
  if (full.length <= MAX_BTN) return full;
  return `${full.slice(0, MAX_BTN - 1)}…`;
}
```

- [ ] **Step 2: Type check**: `npm run check`
Expected: PASS

### Task 4: formatExitPlanMode

**Files:**
- Modify: `src/format.ts`

- [ ] **Step 1: Add ExitPlanMode formatter**

Add to `src/format.ts`:

```typescript
/**
 * Format an ExitPlanMode permission prompt.
 * Renders plan text from the description or input fields.
 */
export function formatExitPlanMode(
  input: Record<string, unknown>,
  description: string,
): string {
  // Plan text may be in description, input.plan, or fall back to allowedPrompts
  const plan = description
    || (typeof input.plan === "string" ? input.plan : null)
    || JSON.stringify(input, null, 2);
  const lines = plan.split("\n");
  const body = truncateLines(lines, MAX_LINES);
  return `📋 Plan Review\n\n${body}`;
}
```

- [ ] **Step 2: Type check**: `npm run check`
Expected: PASS

### Task 5: formatTodoList

**Files:**
- Modify: `src/format.ts`

- [ ] **Step 1: Add TodoWrite formatter**

Add to `src/format.ts`:

```typescript
interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

/**
 * Format a TodoWrite task list for display.
 */
export function formatTodoList(input: Record<string, unknown>): string {
  const todos = (input.todos ?? []) as TodoItem[];
  if (todos.length === 0) return "📋 Tasks\n(empty)";
  const lines = todos.map((t) => {
    switch (t.status) {
      case "completed": return `✅ ${t.content}`;
      case "in_progress": return `⏳ ${t.activeForm}`;
      default: return `⬚ ${t.content}`;
    }
  });
  return `📋 Tasks\n${lines.join("\n")}`;
}
```

- [ ] **Step 2: Type check**: `npm run check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/format.ts
git commit -m "feat: add format functions for AskUserQuestion, ExitPlanMode, TodoWrite"
```

---

## Chunk 3: Tool handler maps

### Task 6: Create tool-handlers.ts — types and AskUserQuestion

**Files:**
- Create: `src/tool-handlers.ts`

- [ ] **Step 1: Create file with types + AskUserQuestion handler**

Create `src/tool-handlers.ts` with exported types (`ToolPromptResult`, `ToolPromptHandler`, `ToolDisplayHandler`) and the `handleAskUserQuestion` function.

The handler calls `formatAskUserQuestion(input)` to get text + options, builds one button row per option using `truncateButtonLabel()`, adds an "Other…" button with `requestText: true`.

`mapResponse`: if value is `"__other__"`, use `resp.text` as answer. Otherwise use `resp.value` (option label). Return `{ decision: "allow", updatedInput: { questions, answers: { [questionText]: answer } } }`.

- [ ] **Step 2: Type check**: `npm run check`

### Task 7: Add remaining handlers + export maps

- [ ] **Step 1:** Add `handleExitPlanMode` — calls `formatExitPlanMode(input, description)`. Buttons: Approve/Reject/Reject+Note. Approve → allow w/ `updatedInput: input`. Reject → deny w/ message.
- [ ] **Step 2:** Add `handleEnterPlanMode` — returns `null` (auto-allow signal).
- [ ] **Step 3:** Export `permissionHandlers` Map (AskUserQuestion, ExitPlanMode, EnterPlanMode) and `displayHandlers` Map (no-op entries for those 3 to suppress status flicker).
- [ ] **Step 4:** `npm run check` + commit: `"feat: tool handler maps"`

---

## Chunk 4: Orchestrator wiring

### Task 8: Permission handler dispatch in orchestrator

**Modify:** `src/orchestrator.ts`

- [ ] **Step 1:** Import `permissionHandlers`, `displayHandlers` from `./tool-handlers.js`.
- [ ] **Step 2:** In `onPermissionRequest` (line 264), before `formatPermissionPrompt`, add handler lookup. If handler returns `null` (EnterPlanMode): send "📋 Entering plan mode" notification + return `{ decision: "allow" }`. If non-null: call `sendInteractive` with handler's text+buttons, then `mapResponse(resp)`.
- [ ] **Step 3:** `npm run check`

### Task 9: Display handler dispatch + TodoWrite

**Modify:** `src/orchestrator.ts`

- [ ] **Step 1:** Add `todoHandle: string | null` to `ChatState`, init to `null`.
- [ ] **Step 2:** In `routeEngineEvent` `tool_use` case, before rolling status line: check `displayHandlers.has(event.toolName)`. For TodoWrite: render via `formatTodoList(event.input)`, create/edit rolling `todoHandle` message. For others: just `break` (suppress flicker).
- [ ] **Step 3:** Import `formatTodoList` from `./format.js`. Add TodoWrite to `displayHandlers` in tool-handlers.ts.
- [ ] **Step 4:** In `done` case, reset `state.todoHandle = null`.
- [ ] **Step 5:** `npm run check` + commit: `"feat: wire tool handler dispatch in orchestrator"`

---

## Chunk 5: Verify

### Task 10: Build and manual test

- [ ] **Step 1:** `npm run check` + `npm run build`
- [ ] **Step 2:** Manual Telegram test — trigger AskUserQuestion. Verify formatted question + option buttons. Verify answer relayed.
- [ ] **Step 3:** Manual test TodoWrite — trigger multi-step task. Verify task list appears and updates in place.
- [ ] **Step 4:** Manual test ExitPlanMode — trigger plan mode. Verify plan renders + approve/reject works.
