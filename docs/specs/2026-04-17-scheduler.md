# Scheduler — Design Spec

Status: **Design** — approved, ready for implementation planning.

## What

Scheduled/timed bot-initiated turns. ClearClaw kicks off agent turns without a user message, based on time triggers (cron expressions or one-shot timers).

## Use Cases

- **Recurring agent tasks** — "Every morning, check my email and summarize", "Every hour, run the test suite"
- **One-shot reminders** — "Remind me at 3pm to review that PR"
- **Automated workflows** — "On a schedule, pull RSS feeds, check deploy status"

## Architecture

### Proactive Prompt Primitive

Scheduler, heartbeat, idle housekeeping, and event-driven triggers are all variations of the same primitive: **bot-initiated turns**. The primitive is a public method on Orchestrator that creates a synthetic `InboundMessage` and feeds it into the existing turn pipeline.

```
proactive prompts (base primitive on Orchestrator)
|-- scheduler        -- triggered by time/cron (user-configured)
|-- idle housekeeping -- triggered by inactivity + context pressure (system, future)
|-- heartbeat        -- triggered by app startup (future)
`-- event-driven     -- triggered by external events (future)
```

The primitive is designed so that future consumers plug in without changing the core.

#### injectPrompt

```typescript
// On Orchestrator
public injectPrompt(prompt: string): void
```

- Resolves the home workspace (default workspace) and its `chat_id`
- Creates a synthetic `InboundMessage` with the prompt as text and a system user identity
- Calls `enqueueMessage()` with the home workspace as context
- The turn runs through the normal pipeline: same session, same engine, same event routing
- Always targets the home workspace; scheduled turns are autonomous assistant work

### Scheduled Turn Behavior

- **Session:** Uses workspace's current session. Follow-up replies work naturally.
- **Behavior mode:** Always `assistant` (bypassPermissions).
- **Concurrency:** Queues behind active turns via existing message queue.
- **Failure:** Log error, notify chat, no retries. One-shot failures marked as failed.

### Scheduler Class

`src/scheduler.ts` owns cron timer lifecycle. Calls `orchestrator.injectPrompt()`.

- `start()` — read enabled schedules from config, create `croner` Cron instances
- `stop()` — stop all Cron instances
- `add/remove/list/toggle` — CRUD with config persistence

On startup, rebuilds timers. Missed executions while down are missed (no catch-up).

### Cron Library: croner

Lightweight, zero-dep, well-maintained. Standard cron + seconds. Timezone via option.

## Data Model

Schedules stored in `config.json` alongside workspaces.

```typescript
interface ScheduleEntry {
  id: string;           // random ID
  cron: string;         // cron expression
  prompt: string;       // turn prompt text
  enabled: boolean;
  oneShot?: boolean;    // auto-disable after first run
  timezone?: string;    // IANA timezone, defaults to system
  createdAt: number;    // epoch ms
}
```

Schedules are global (not per-workspace). Execution always targets the home workspace. MCP tools for schedule management are available in all workspace turns.

Config methods: `listSchedules()`, `addSchedule()`, `removeSchedule()`, `updateSchedule()`.

## Management Interface

### MCP Tools (user-facing schedules only)

Available in all turns. Agent manages schedules conversationally. System behaviors (housekeeping, heartbeat) are internal, not exposed through MCP tools.

- `schedule_create`, `schedule_list`, `schedule_delete`, `schedule_toggle`

### /schedule Chat Command (future)

Not in initial scope. Chat commands for schedule inspection can come later alongside workspace management commands.

## Idle Housekeeping (future, informs design)

Separate system behavior, not part of scheduler. Uses the same proactive prompt primitive but is internally managed. Triggered by inactivity + context pressure with exponential backoff (30min initial, doubling to 4hr cap). May include lightweight session classifier. Invisible to user. Tracked separately.

## Build Order

1. Add `croner` dependency
2. Config CRUD for schedule entries (`ScheduleEntry`, CRUD methods)
3. Proactive prompt primitive (`injectPrompt()` on Orchestrator)
4. Scheduler class (croner integration, lifecycle)
5. Wire scheduler into Orchestrator start/stop
6. MCP tools (schedule_create, schedule_list, schedule_delete, schedule_toggle)

## Files

| File | Role |
|------|------|
| `src/scheduler.ts` | New. Scheduler class, cron timer management |
| `src/orchestrator.ts` | `injectPrompt()`, scheduler lifecycle, MCP tools |
| `src/config.ts` | `ScheduleEntry` type, CRUD methods, extend `ConfigData` |
