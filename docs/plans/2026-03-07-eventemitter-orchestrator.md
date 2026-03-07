# Plan: EventEmitter Channel + Orchestrator Extraction

## Context

Two coupled refactors from `docs/TASKS.md`:
1. **Refactor Channel to EventEmitter** — remove constructor callback injection from `TelegramChannel`; channel emits events, orchestrator subscribes
2. **Extract orchestrator from index.ts** — pull all message handling, event routing, busy state, workspace management into a proper `Orchestrator` class in `src/orchestrator.ts`; leave `index.ts` as a thin bootstrap

These are tightly coupled and best done as one changeset.

---

## Step 1: Update `src/types.ts` — Add typed event emitter to Channel

### What and why

Currently `TelegramChannel` takes an `onMessage` callback in its constructor (via `TelegramChannelOpts`). This creates a tight coupling: the channel must know its consumer at construction time, and the consumer's async error handling is tangled into the channel's `connect()` method. Switching to an EventEmitter pattern decouples these — the channel just announces "a message arrived" and the orchestrator decides what to do with it.

### The `ChannelEvents` interface

`ChannelEvents` is a **type-level event map** — a pattern used throughout TypeScript to get type-safe `.on()` / `.emit()` calls on an EventEmitter. It maps event name strings to their argument tuples:

```typescript
export interface ChannelEvents {
  message: [msg: InboundMessage];
}
```

Right now it has a single event (`message`), but the interface exists so we can add more events later without changing signatures — e.g. `disconnect: []`, `error: [err: Error]`, `reconnect: [attempt: number]`. Each key is the event name; each value is the tuple of arguments the listener receives.

`ChannelEvents` follows the codebase convention of shorter names (`Channel` not `ChannelAdapter`, `Engine` not `EngineAdapter`).

### Typed methods on Channel

We add three generic method signatures to the existing `Channel` interface:

```typescript
// Add to Channel interface:
on<K extends keyof ChannelEvents>(event: K, listener: (...args: ChannelEvents[K]) => void): this;
off<K extends keyof ChannelEvents>(event: K, listener: (...args: ChannelEvents[K]) => void): this;
emit<K extends keyof ChannelEvents>(event: K, ...args: ChannelEvents[K]): boolean;
```

These constrain `event` to only valid keys of `ChannelEvents`, and the `listener` args are automatically inferred from the tuple. So `channel.on("message", (msg) => ...)` gets `msg: InboundMessage` for free — no casts needed. Calling `channel.on("typo", ...)` is a compile error.

At runtime these are satisfied by Node's built-in `EventEmitter` (which `TelegramChannel` will extend in Step 2). No new dependencies.

### No breaking changes yet

Step 1 only touches `types.ts`. The `Channel` interface gains three new methods, which means `TelegramChannel` won't satisfy it until Step 2 adds `extends EventEmitter`. That's fine — steps 1+2 are one atomic commit.

---

## Step 2: Update `src/channel/telegram.ts` — Extend EventEmitter, remove callback

- Import `EventEmitter` from `node:events`
- Remove `TelegramChannelOpts` interface entirely
- Class becomes `extends EventEmitter implements Channel`
- Constructor signature: `(botToken, allowedChatId)` — no more opts param
- In `connect()`: replace `this.opts.onMessage({...}).catch(...)` → `this.emit("message", {...})`
- Remove `private opts` field
- All other methods unchanged (sendMessage, sendInteractive, setTyping, disconnect, ownsId)

Key: `emit()` is synchronous. The orchestrator's async listener returns a floating promise — its own responsibility to catch errors (cleaner separation of concerns than the current pattern).

---

## Step 3: Create `src/orchestrator.ts` — New Orchestrator class

Extract all logic from `main()` in `index.ts`:

```
class Orchestrator {
  constructor(opts: OrchestratorOpts)  // { channel, engine, channelId, defaultCwd, permissionMode }
  start(): Promise<void>               // seed workspace, subscribe to channel events, connect, register shutdown
  stop(): Promise<void>                // disconnect channel
  private handleMessage(msg)           // command handling, busy guard, workspace lookup, run turn, error reporting
  private routeEngineEvent(channelId, event)  // switch on event.type → sendMessage/format/log/updateSession
}
```

Responsibilities moved from `index.ts`:
- Workspace seeding (default "main")
- `channel.on("message", ...)` subscription with `.catch()` safety net
- `handleMessage()`: `/new` command, busy rejection, workspace lookup, `engine.runTurn()` iteration
- `routeEngineEvent()`: text/tool_use/tool_result/rate_limit/done/error dispatch — each call is `await`ed inside the `for await` loop so Telegram messages arrive in the same order the engine emits them
- Permission bridging: `onPermissionRequest` → `channel.sendInteractive()`
- Outer try/catch preserving "Internal error" user notification
- SIGINT/SIGTERM → `this.stop()`

Imports: `log`, `db` functions, `formatToolUse`/`formatToolResult`, types

---

## Step 4: Slim `src/index.ts` — Thin bootstrap (~20 lines)

```typescript
import { loadConfig } from "./config.js";
import { initDb } from "./db.js";
import { ClaudeCodeEngine } from "./engine/claude-code.js";
import { TelegramChannel } from "./channel/telegram.js";
import { Orchestrator } from "./orchestrator.js";
import log from "./logger.js";

async function main() {
  const config = loadConfig();
  initDb();

  const channel = new TelegramChannel(config.botToken, config.allowedChatId);
  const engine = new ClaudeCodeEngine();

  const orchestrator = new Orchestrator({
    channel,
    engine,
    channelId: `tg:${config.allowedChatId}`,
    defaultCwd: config.defaultCwd,
    permissionMode: config.permissionMode,
  });

  await orchestrator.start();
}

main().catch((err) => {
  log.fatal({ err }, "Fatal");
  process.exit(1);
});
```

---

## Step 5 (bonus): Move `formatToolDescription` from `engine/claude-code.ts` → `format.ts`

Per TASKS.md item. The function (lines 189-203 in claude-code.ts) is a formatting concern used to build permission prompt text. Move it to `format.ts`, export it, import in claude-code.ts.

---

## Files Modified

| File | Action |
|------|--------|
| `src/types.ts` | Add `ChannelEvents`, typed `on`/`off`/`emit` to `Channel` |
| `src/channel/telegram.ts` | Extend `EventEmitter`, remove callback injection |
| `src/orchestrator.ts` | **New file** — `Orchestrator` class |
| `src/index.ts` | Slim to bootstrap only |
| `src/engine/claude-code.ts` | Remove `formatToolDescription` |
| `src/format.ts` | Receive `formatToolDescription` |

---

## Verification

1. `npx tsc --noEmit` — type-check passes
2. `npm run dev` — bot starts, logs "ClearClaw ready."
3. Send a message in Telegram → bot responds (text events routed)
4. Trigger a tool use (e.g. ask it to read a file) → tool_use/tool_result formatted and sent
5. Send `/new` → "Session cleared." response
6. Send message while busy → "Still working..." rejection
7. Permission prompt appears with Allow/Deny buttons, responds correctly
