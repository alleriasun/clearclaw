# Plan: Multi-user support with platform-prefixed IDs

## Context

ClearClaw currently hardcodes a single `ALLOWED_USER_ID` (numeric). This blocks multi-user group chats and doesn't carry user identity through to the orchestrator. This change widens the auth gate to a set of user IDs, adds `userId` to inbound messages, and ensures all IDs use the `tg:` prefix convention consistently.

## Changes

### 1. `src/types.ts` — Add userId to InboundMessage

Add `userId: string` field (platform-prefixed, e.g. `tg:123456`):

```typescript
export interface InboundMessage {
  chatId: string;
  userId: string;
  text: string;
}
```

### 2. `src/config.ts` — Single ID → Set of IDs

- `Config.allowedUserId: number` → `Config.allowedUserIds: Set<number>`
- Read `ALLOWED_USER_IDS` env var, fall back to `ALLOWED_USER_ID` for backwards compat
- Parse as comma-separated numbers, validate each, build `Set<number>`

### 3. `src/channel/telegram.ts` — Multi-user auth + emit userId

- Constructor: `allowedUserId: number` → `allowedUserIds: Set<number>`
- Auth: `ctx.from?.id !== this.allowedUserId` → `!ctx.from?.id || !this.allowedUserIds.has(ctx.from.id)`
- Emit: add `userId: \`tg:${ctx.from.id}\`` to message events

### 4. `src/index.ts` — Wire allowedUserIds

- `config.allowedUserId` → `config.allowedUserIds` in TelegramChannel constructor

### 5. `src/orchestrator.ts` — Log userId

- Add `user=${msg.userId}` to the message log line

### 6. Docs

- **CLAUDE.md**: Update env var line to show `ALLOWED_USER_IDS` with backwards-compat note
- **docs/ARCHITECTURE.md**: Update config section
- **docs/TASKS.md**: Mark "Remove numeric ID assumption" and "Multi-user support" as complete

## ID Audit (no changes needed)

All downstream code already treats IDs as opaque strings:

| Location | ID | Status |
|---|---|---|
| `orchestrator.ts` | `msg.chatId` | String, no coercion |
| `workspace-store.ts` `byChat()` | `chatId` | String comparison |
| `telegram.ts` `numericId()` | Internal to channel | Correctly strips `tg:` for Telegram API calls only |
| `telegram.ts` `ownsId()` | Checks `tg:` prefix | Correct routing check |

Raw numeric IDs exist only in config (env parsing) and inside the channel (auth + API calls). Clean boundary.

## What this does NOT do

- **No orchestrator routing changes** — still routes by chatId
- **No workspace schema changes** — still chat-scoped
- **No message queue** — separate task; concurrent messages correctly get "Still working..." rejection

## Verification

```bash
npm run check    # tsc --noEmit — type-check passes
npm run build    # compiles to dist/
```

Manual: set `ALLOWED_USER_IDS=id1,id2`, verify both users can send messages and unauthorized users are still ignored. Verify `ALLOWED_USER_ID=id1` (old form) still works.
