# Plan: Session-level permission mode switching

## Context

ClearClaw sets permission mode globally via `PERMISSION_MODE` env var at startup. All workspaces share the same mode for the lifetime of the process. Claude Code's CLI lets users cycle between modes mid-session with Shift+Tab. ClearClaw needs this — a `/mode` command that switches modes per-workspace, with a persistent status indicator.

**Scope:** Mode switching (`/mode` command) + pinned status message. Per-tool session allowlists ("Allow for session" button) deferred to a follow-up.

## Design

### `/mode` command

Shows current mode and offers inline buttons to switch:

```
Current mode: Default

[✓ Default]     [Accept Edits]
[Plan]          [Bypass]
```

User taps "Accept Edits" → mode updates, pinned status message reflects it.

**Modes exposed:**

| Mode | Label | SDK value | Behavior |
|------|-------|-----------|----------|
| Default | Default | `default` | Every tool → prompt |
| Accept Edits | Accept Edits | `acceptEdits` | File edits auto-approved |
| Plan | Plan | `plan` | Plan mode |
| Bypass | Bypass | `bypassPermissions` | All tools auto-approved |

`dontAsk` excluded — near-identical to `bypassPermissions`, adds confusion without value.

**Scope:** Per-workspace, in-memory. Falls back to `config.permissionMode` on restart.

**`/new` behavior:** Resets mode to config default. `/new` = fresh start — you don't want to accidentally start a new conversation in bypass mode because you forgot you set it hours ago. If you want the same mode again, it's two taps via `/mode`.

### Pinned status message

A pinned message in each chat acts as a persistent status bar — the Telegram equivalent of the CLI's bottom status line.

```
⚙️ Default
```

Updated in place (silent `editMessageText`) whenever mode changes. Created + pinned on first `/mode` use — if you never switch modes, no pinned message appears.

**How it works — channel as stateless transport:**

The channel doesn't track status state. Instead, `sendMessage` returns message handles, and the Channel interface exposes `editMessage`, `deleteMessage`, and `pinMessage` as primitives. The orchestrator owns the status handle in its `ChatState`:

- `sendMessage` return type changes from `Promise<void>` to `Promise<string[]>` (array of handles, one per chunk after splitting)
- New Channel methods: `editMessage(chatId, handle, text)`, `deleteMessage(chatId, handle)`, `pinMessage(chatId, handle)`
- Orchestrator's `ChatState` gets `statusHandle?: string`
- First `/mode` use: `sendMessage` → store `handles[0]` in `state.statusHandle` → `pinMessage`
- Subsequent mode changes: `editMessage` on `state.statusHandle`

Existing callers of `sendMessage` all ignore the return value (fire-and-forget), so the return type change is non-breaking.

**On restart:** In-memory `statusHandle` is lost. Next `/mode` creates and pins a new message. The old one stays in history but Telegram's header shows the latest pin. Accumulation is slow (restarts are rare). Persisting the handle to DB is a future improvement if this becomes noisy.

**Admin permissions in groups:** `pinMessage` requires the bot to be admin. If the bot isn't admin, the orchestrator should catch the error gracefully — log a warning, skip the pin. The mode switch still works; you just don't get the pinned indicator.

**Why pinned message over alternatives:**
- *Confirmation-only (no pin):* Simpler, but you forget what mode you're in. `/mode` with no args tells you, but it's an extra step.
- *Turn-start indicator:* Adds noise to every response.
- *Pinned message:* Always visible in the chat header. Silent updates. Platform-native. Worth the minor complexity.

### Button layout

Current `sendInteractive` takes a flat `Button[]`. Four mode buttons in one row is cramped on mobile. Change the signature to `Button[][]` — each inner array is a row. Layout is expressed by the caller, not encoded as a property on Button (layout is not a button concern).

```ts
// Permission prompt — one row
[[allow, deny, denyNote]]

// Mode picker — 2×2 grid
[[default, acceptEdits], [plan, bypass]]
```

## Changes

### `src/types.ts`

1. `sendInteractive` signature: `buttons: Button[]` → `buttons: Button[][]` (rows of buttons)
2. `sendMessage` return type: `Promise<void>` → `Promise<string[]>` (message handles)
3. Add to `Channel` interface:
   - `editMessage(chatId: string, handle: string, text: string): Promise<void>`
   - `deleteMessage(chatId: string, handle: string): Promise<void>`
   - `pinMessage(chatId: string, handle: string): Promise<void>`

### `src/channel/telegram.ts`

1. `sendMessage`: collect `message_id` from each `bot.api.sendMessage` call, return as `String(id)[]`
2. `sendInteractive`: iterate `Button[][]` — each inner array is a keyboard row (call `keyboard.row()` between rows)
3. Implement `editMessage`: `bot.api.editMessageText(numId, Number(handle), text)`
4. Implement `deleteMessage`: `bot.api.deleteMessage(numId, Number(handle))`
5. Implement `pinMessage`: `bot.api.pinChatMessage(numId, Number(handle), { disable_notification: true })`

### `src/orchestrator.ts`

1. Extend `ChatState`:
   ```typescript
   interface ChatState {
     busy: boolean;
     abort: AbortController | null;
     permissionMode: PermissionMode | null;  // null = use config default
     statusHandle: string | null;            // pinned status message handle
   }
   ```

2. Add `/mode` command handler (before busy guard — mode switching works anytime, even during active turns):
   - Build `Button[][]` for each mode (2×2 grid), mark current mode with `✓` prefix
   - `sendInteractive` with mode buttons
   - On response: update `state.permissionMode`, create or edit pinned status message via `sendMessage`/`editMessage`/`pinMessage`
   - On timeout/no response: no-op

3. Use `state.permissionMode ?? this.permissionMode` when calling `engine.runTurn()`

4. Update `/new` handler: reset `state.permissionMode = null`, update pinned status message if `state.statusHandle` exists

### `docs/TASKS.md`

- Split "Session-scoped permission allowlists" → two items: mode switching (done) + per-tool allowlists (remaining)

## Adjacent: typing indicator during permission prompts

Separate from this plan, but noted here since Sam flagged it:

Currently the typing indicator runs throughout the entire turn, including while waiting for tool approval. The fix is two lines in the `onPermissionRequest` callback:
- `setTyping(false)` before `sendInteractive`
- `setTyping(true)` after the response

Small standalone change, no interface changes needed.

## What this does NOT change

- **Config/env:** `PERMISSION_MODE` remains the startup default
- **Engine interface:** `RunTurnOpts.permissionMode` still receives a mode string — engine doesn't know about switching
- **DB schema:** No changes — mode and status message ID are in-memory
- **Per-tool allowlists:** Deferred — "Allow for session" button is a follow-up feature

## Verification

```bash
npm run check
npm run build
```

Manual:
1. Start with `PERMISSION_MODE=default`
2. `/mode` → see current mode highlighted, 4 buttons in 2×2 grid
3. Tap "Accept Edits" → pinned message appears: `⚙️ Accept Edits`
4. Send a message with file edits → edits auto-approved, other tools still prompt
5. `/mode` → "Accept Edits" has ✓ prefix
6. Tap "Default" → pinned message updates silently
7. `/new` → session clears, mode resets to config default, pinned status updates
8. Restart process → mode resets to env var default, old pinned message stays but new one created on next `/mode`
