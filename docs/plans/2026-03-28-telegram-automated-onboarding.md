# Plan: Automated Telegram Workspace Onboarding via TDLib

## Context

Setting up a new ClearClaw workspace on Telegram has significant friction:

1. Manually create a Telegram group
2. Add the bot to the group
3. Promote the bot to admin (needed for pin permissions)
4. Group migrates to supergroup — **chat ID changes**, breaking workspace mapping
5. Re-configure or hope migration handling exists (it doesn't yet)

The pinned status message (model, context %, permission mode) is a core UX element that requires admin pin permissions. Without it, stats are invisible.

Additionally, the bot token itself requires a manual BotFather conversation.

### Current pain points

- **Pin permissions:** Bot can't pin without admin. Logs show consistent `400: Bad Request: not enough rights to manage pinned messages` across all groups since the feature shipped.
- **Group migration:** Promoting bot to admin triggers Telegram's group → supergroup migration, changing the chat ID. The workspace store still has the old ID → broken.
- **Status handle persistence:** The `statusHandles` map is in-memory. Server restarts lose track of which message is pinned, creating orphaned stale pins.
- **Bot token:** Requires manual `/newbot` conversation with @BotFather.

## Research: What the Telegram Client API (TDLib) Can Do

The Bot API cannot create groups or promote itself. But the **Client API (TDLib)** — which authenticates as a user account, not a bot — can automate the full flow:

### Full automated flow

1. **Auth as user** — one-time phone number + OTP, session persists after that
2. **Create bot token** — automate the @BotFather conversation:
   - `searchPublicChat("BotFather")` → open chat
   - `sendMessage` → `/newbot`
   - Parse replies, send bot name + username
   - Extract token from BotFather's confirmation message
   - *Note: this is conversational scraping, not a proper API. Fragile if BotFather's message format changes.*
3. **Create group** — `createNewBasicGroupChat(title, [botUserId])` creates group with bot as initial member
4. **Promote bot to admin** — `setChatMemberStatus(chatId, botUserId, chatMemberStatusAdministrator(rights))` with `can_pin_messages: true`
5. **Return chat ID + bot token** to ClearClaw config

### Key TDLib methods

| Method | Purpose |
|--------|---------|
| `createNewBasicGroupChat` | Create group, can include bot as initial member |
| `addChatMember` | Add bot if not included at creation |
| `setChatMemberStatus` | Promote to admin with granular permission flags |
| `searchPublicChat` | Find @BotFather or bot by username |
| `sendMessage` / message updates | Automate BotFather conversation |

### Requirements

- `api_id` + `api_hash` from https://my.telegram.org (one-time)
- Phone number authentication (session persists)
- TDLib native library or JS wrapper ([tdl](https://www.npmjs.com/package/tdl) on npm)

### Tradeoffs

**Pros:**
- Zero-friction onboarding after initial phone auth — single `/setup` command
- Eliminates all manual Telegram steps
- Handles migration implicitly (we control the group creation)
- Bot token creation could be part of first-run setup

**Cons:**
- Adds native dependency (TDLib C++ lib) or JS wrapper
- User-account auth is a separate, more complex auth flow than bot tokens
- BotFather automation is conversational scraping — fragile
- Only needed for one-time setup per workspace — high complexity for low frequency

## Pragmatic Alternative: Handle Migration + Persist Handles

If TDLib is too heavy for what's ultimately a one-time setup, the minimum viable fix is:

### 1. Handle `migrate_to_chat_id` events

Telegram sends this when a group upgrades to supergroup. Listen in the Telegram channel, emit to orchestrator, auto-update workspace store. Manual setup still required, but nothing breaks.

### 2. Persist status message handles

Store the pinned message ID in `workspaces.json` (or workspace store) so server restarts don't orphan the pinned message.

### 3. One-time permission nudge

When pin fails, send a message to the chat: "Grant me 'Pin Messages' admin permission so I can keep stats visible." Only once per chat.

## Decision

**Not decided yet.** Options ranked by effort:

1. **Migration handling + persist handles + nudge** — small code change, removes the breakage, still manual setup
2. **TDLib for group setup only** — automate group creation + admin promotion, keep manual bot token
3. **Full TDLib automation** — automate everything including bot token creation

## References

- [TDLib docs](https://core.telegram.org/tdlib/docs/)
- [TDLib getting started](https://core.telegram.org/tdlib/getting-started)
- [tdl (JS wrapper)](https://www.npmjs.com/package/tdl)
- [createNewBasicGroupChat](https://hexdocs.pm/tdlib/TDLib.Method.CreateNewBasicGroupChat.html)
- [setChatMemberStatus](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1set_chat_member_status.html)
- [chatMemberStatusAdministrator](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1chat_member_status_administrator.html)
- [Telegram Bot API](https://core.telegram.org/bots/api)
