# Scheduler Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scheduled/timed bot-initiated turns to ClearClaw via a proactive prompt primitive and croner-based scheduler.

**Architecture:** `injectPrompt()` on Orchestrator creates synthetic messages for the existing turn pipeline. Scheduler class wraps croner for cron timers backed by config.json. MCP tools for conversational management.

**Tech Stack:** TypeScript, croner, existing ClearClaw architecture

**Spec:** `docs/specs/2026-04-17-scheduler.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/config.ts` | ScheduleEntry interface, CRUD methods, schedules in ConfigData |
| Create | `src/scheduler.ts` | Scheduler class: croner lifecycle, injectPrompt caller |
| Modify | `src/orchestrator.ts` | injectPrompt(), scheduler lifecycle, MCP tools |
| Modify | `package.json` | Add croner dependency |

---

## Chunk 1: Foundation

### Task 1: Install croner

- [ ] `npm install croner`
- [ ] `npm run check`
- [ ] Commit: `chore: add croner dependency for scheduler`

### Task 2: Add ScheduleEntry to config

**Modify:** `src/config.ts`

- [ ] Add `ScheduleEntry` interface after `EngineEntry` (~line 45):

```typescript
export interface ScheduleEntry {
  id: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  oneShot?: boolean;
  timezone?: string;
  createdAt: number;
}
```

- [ ] Add `schedules: ScheduleEntry[]` to `ConfigData`
- [ ] Update `read()` to include: `schedules: (raw.schedules ?? []) as ScheduleEntry[]`
- [ ] Add schedule CRUD methods after workspace section (~line 319):
  - `listSchedules()` - return all schedules
  - `addSchedule(entry)` - push and write
  - `removeSchedule(id)` - filter out and write
  - `updateSchedule(id, partial)` - find, Object.assign, write
- [ ] Make `generateCode()` public as `generateId()` (scheduler needs random IDs, same alphabet)
- [ ] `npm run check`
- [ ] Commit: `feat: add ScheduleEntry config CRUD for scheduler`

### Task 3: Add injectPrompt to Orchestrator

**Modify:** `src/orchestrator.ts`

The proactive prompt primitive. Creates a synthetic `InboundMessage` and feeds it into `enqueueMessage()`.

- [ ] Add `injectPrompt(prompt)` public method after `stop()` (~line 123):
  - Resolve home workspace via config (workspace named `default`, or add `homeWorkspace()` helper that finds by `cwd === homeWorkspacePath`)
  - Create synthetic `InboundMessage` with `user: { id: "system:scheduler", name: "Scheduler" }` (prefixed to avoid collision with real users)
  - Call `this.enqueueMessage(msg, ws, state)`
  - Log the injection
- [ ] In `executeTurn()`, override behavior for injected turns: detect `user.id.startsWith("system:")` in messages, force `assistant` behavior (bypassPermissions). Replace the existing `const behavior = this.effectiveBehavior(ctx)` with a check.
- [ ] `npm run check`
- [ ] Commit: `feat: add injectPrompt proactive prompt primitive`

### Task 4: Create Scheduler class

**Create:** `src/scheduler.ts`

- [ ] Create scheduler module with:
  - `constructor(config, orchestrator)` - store references
  - `start()` - read enabled schedules from config, create `Cron` instances, store in `Map<string, Cron>`
  - `stop()` - stop all Cron instances, clear map
  - `add(entry)` - persist to config + create Cron if enabled
  - `remove(id)` - stop Cron + remove from config
  - `toggle(id, enabled)` - enable/disable: create or stop Cron + update config
  - `list()` - delegate to config.listSchedules
  - Private `createJob(entry)` - create Cron with timezone option, callback calls `orchestrator.injectPrompt(entry.prompt)`, handles oneShot auto-disable
- [ ] `npm run check`
- [ ] Commit: `feat: scheduler class with croner cron management`

### Task 5: Wire Scheduler into Orchestrator lifecycle

**Modify:** `src/orchestrator.ts`

- [ ] Import `Scheduler` from `./scheduler.js`
- [ ] Add `private scheduler: Scheduler | null = null` field
- [ ] In `start()`, after channel connect: create Scheduler and call `start()`
- [ ] In `stop()`, before channel disconnect: call `scheduler.stop()`
- [ ] `npm run check`
- [ ] Commit: `feat: wire scheduler into orchestrator lifecycle`

---

## Chunk 2: MCP Tools + Wrap-up

### Task 6: Add scheduler MCP tools

**Modify:** `src/orchestrator.ts`

Available in all workspace turns (not task turns). Schedules are global; execution targets home workspace.

- [ ] Import `ScheduleEntry` from `./config.js`
- [ ] In `buildMcpTools()`, add scheduler tools gated on `!this.tasks.has(chatId) && this.scheduler`:
  - `schedule_create` - args: cron, prompt, timezone?, one_shot?
  - `schedule_list` - no args, format as bullet list
  - `schedule_delete` - args: id
  - `schedule_toggle` - args: id, enabled
- [ ] `npm run check`
- [ ] Commit: `feat: scheduler MCP tools for conversational management`

### Task 7: Update TASKS.md + final build

**Modify:** `docs/TASKS.md`

- [ ] Mark scheduler tasks complete
- [ ] Add Session Maintenance section (idle housekeeping + session classifier as future backlog)
- [ ] `npm run build && npm run check`
- [ ] Commit: `docs: mark scheduler tasks complete, add session maintenance backlog`
