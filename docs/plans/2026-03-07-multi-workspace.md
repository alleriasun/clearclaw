# Plan: Multi-workspace Core Routing

## Context

Phase 2 from `docs/TASKS.md`. The orchestrator hardcodes `DEFAULT_WORKSPACE = "main"` — all messages route to it, `/new` and `done` reference it by name, and a single `busy` flag blocks everything. Auth gates on chat ID, limiting the bot to one group.

This plan adds the core routing so the orchestrator handles any number of workspaces, each in its own Telegram group. Workspace creation (commands, onboarding CLI) is future work — for now, second workspaces are added via manual SQLite inserts.

### Design decisions (from discussion)

1. **One Telegram group = one workspace.** `channel_id UNIQUE` stays.
2. **User-based auth.** `ALLOWED_USER_ID` replaces `ALLOWED_CHAT_ID`. Bot responds to the allowed user in any group. Instance-global — no per-workspace user lists.
3. **No auto-seeding.** The default workspace is not created on startup. An onboarding flow will handle first-time setup (future work). For now, manually insert via SQLite.
4. **Per-workspace busy tracking.** Concurrent turns across workspaces.
5. **Multi-bot = multi-instance.** Separate bots/owners run separate ClearClaw processes with separate `CLEARCLAW_HOME`.

### Out of scope

- `/workspace new|list|delete` commands
- `my_chat_member` detection and auto-linking
- Onboarding / first-launch CLI
- Per-workspace `extraArgs`

---

## Step 1: Config — `ALLOWED_USER_ID` + `CLEARCLAW_HOME`

### What and why

`ALLOWED_CHAT_ID` served dual duty: auth gate + main workspace channel. With user-based auth, we only need the user ID for gating. The workspace-channel mapping lives in the DB, not config.

### `src/config.ts`

```typescript
export interface Config {
  botToken: string;
  allowedUserId: number;     // was allowedChatId
  permissionMode: PermissionMode;
}
```

- `ALLOWED_CHAT_ID` → `ALLOWED_USER_ID`. Telegram user ID (the person, not the chat).
- `DEFAULT_CWD` removed. Workspace cwds live in the DB, set at creation time. The future onboarding flow will default to a convention path (`$CLEARCLAW_HOME/workspaces/default/`) with interactive override.
- `DATA_DIR`: hardcoded `~/.clearclaw` → `process.env.CLEARCLAW_HOME ?? ~/.clearclaw`.
- `allowedChatId` and `defaultCwd` fields removed from `Config`. Workspace-channel bindings and cwds are DB-only.

---

## Step 2: TelegramChannel — User-based auth

### What and why

Switch the auth check from `ctx.chat.id` to `ctx.from.id`. Constructor takes `allowedUserId` instead of `allowedChatId`.

### `src/channel/telegram.ts`

```typescript
// Constructor:
constructor(botToken: string, allowedUserId: number)

// Auth in connect():
this.bot.on("message:text", (ctx) => {
  if (ctx.from?.id !== this.allowedUserId) return;   // was ctx.chat.id
  const channelId = `tg:${ctx.chat.id}`;
  this.emit("message", { channelId, text: ctx.message.text });
});
```

Everything else unchanged — `channelId` still derived from `ctx.chat.id`, outbound messages still use `numericId()`.

---

## Step 3: Orchestrator — Multi-workspace routing

### What and why

Remove all references to `DEFAULT_WORKSPACE` and `this.channelId`. The orchestrator becomes workspace-agnostic — it just looks up the workspace for whatever channel a message comes from.

### 3a: Remove `channelId` and seeding from `OrchestratorOpts` / `start()`

`channelId` and `defaultCwd` are removed from opts. `start()` no longer seeds a workspace — it just subscribes to events and connects.

```typescript
export interface OrchestratorOpts {
  channel: Channel;
  engine: Engine;
  permissionMode: PermissionMode;
}
```

`start()` becomes:

```typescript
async start(): Promise<void> {
  this.channel.on("message", (msg) => {
    this.handleMessage(msg).catch((err) => {
      log.error({ err }, "[orchestrator] unhandled message error");
    });
  });
  await this.channel.connect();
  log.info("ClearClaw ready.");
  // ... shutdown handlers unchanged
}
```

### 3b: `/new` — use workspace from channel lookup

```typescript
// Before:
clearSession(DEFAULT_WORKSPACE);

// After:
const ws = getWorkspaceByChannel(msg.channelId);
if (!ws) return;
clearSession(ws.name);
```

### 3c: `routeEngineEvent` — workspace-aware session update

Add `workspaceName` parameter:

```typescript
private async routeEngineEvent(
  channelId: string,
  event: EngineEvent,
  workspaceName: string,     // new
): Promise<void> {
  // ... all cases unchanged except:
  case "done":
    updateSessionId(workspaceName, event.sessionId);  // was DEFAULT_WORKSPACE
    break;
}
```

Call site passes `ws.name`:

```typescript
await this.routeEngineEvent(msg.channelId, event, ws.name);
```

### 3d: `busy` → `busyChannels`

Per-workspace concurrency so a long turn in one workspace doesn't block others.

```typescript
private busyChannels = new Set<string>();

// Guard:
if (this.busyChannels.has(msg.channelId)) { ... reject ... }
this.busyChannels.add(msg.channelId);
// finally:
this.busyChannels.delete(msg.channelId);
```

### 3e: Unmapped channel feedback

Currently silently drops messages from unknown channels. Give feedback:

```typescript
if (!ws) {
  await this.channel.sendMessage(msg.channelId, "No workspace linked to this group.");
  return;
}
```

### 3f: Delete `DEFAULT_WORKSPACE` constant

After all references are replaced, the constant is dead code. Remove it.

---

## Step 4: `index.ts` — Wire simplified config

```typescript
// Before:
const channel = new TelegramChannel(config.botToken, config.allowedChatId);
const orchestrator = new Orchestrator({
  channel, engine,
  channelId: `tg:${config.allowedChatId}`,
  defaultCwd: config.defaultCwd,
  permissionMode: config.permissionMode,
});

// After:
const channel = new TelegramChannel(config.botToken, config.allowedUserId);
const orchestrator = new Orchestrator({
  channel, engine,
  permissionMode: config.permissionMode,
});
```

---

## Files modified

| File | Changes |
|------|---------|
| `src/config.ts` | `allowedChatId` → `allowedUserId`, remove `defaultCwd`, add `CLEARCLAW_HOME` |
| `src/channel/telegram.ts` | `allowedChatId` → `allowedUserId`, auth on `ctx.from.id` |
| `src/orchestrator.ts` | Remove `DEFAULT_WORKSPACE`, remove `channelId`/`defaultCwd`, `busy` → `busyChannels`, `routeEngineEvent` takes `workspaceName`, unmapped channel feedback |
| `src/index.ts` | Wire `allowedUserId`, drop `channelId`/`defaultCwd` from orchestrator opts |

---

## Verification

1. `npx tsc --noEmit` — type-check passes
2. Update `.env` — replace `ALLOWED_CHAT_ID=X` with `ALLOWED_USER_ID=Y`
3. Manually seed a workspace:
   ```sql
   INSERT INTO workspaces (name, cwd, channel_id)
   VALUES ('default', '/path/to/cwd', 'tg:<chat-id>');
   ```
4. `npm run dev` — bot starts (no auto-seeding, just connects)
5. Send message in the workspace's group → responds, uses correct cwd and session
6. Send message from a different Telegram user → ignored
7. `/new` → clears this workspace's session (not hardcoded "main")
8. Insert a second workspace pointing to a different group:
   ```sql
   INSERT INTO workspaces (name, cwd, channel_id)
   VALUES ('project-x', '/tmp/project-x', 'tg:<other-group-id>');
   ```
9. Send message in the second group → routes to `project-x` (separate cwd, separate session)
10. Send messages to both groups concurrently → both process independently
11. Send message in an unmapped group → "No workspace linked to this group."
