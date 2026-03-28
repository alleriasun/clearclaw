# Message Bar Autocomplete — Research & Decision

**Date:** 2026-03-27
**Status:** Not pursuing
**Branch:** feature/autocomplete

## Context

When using ClearClaw through Telegram or Slack, it would be useful to have autocomplete in the message composer bar — things like:
- `!` to autocomplete commands
- `@` to autocomplete file paths
- `/` to autocomplete slash commands

This would make the chat-based interaction feel closer to a proper CLI with tab-completion.

## Research

### Telegram Bot API

Telegram offers three relevant mechanisms:

1. **`/` command menu** — Register commands via BotFather or `setMyCommands` API. When a user types `/`, Telegram shows an autocomplete popup. Can be customized per-user, per-group, per-language. This is the most natural fit for ClearClaw slash commands and already partially works.

2. **`@bot` inline queries** — User types `@botname query` anywhere, bot receives an `InlineQuery` callback with the typed text, and returns results as an inline list. Could work for file path completion (e.g., `@clearclaw src/` → list of matching paths). Supports live filtering as the user types.

3. **Menu button** — The button next to the text input can open a command menu or a Mini App (web view). A Mini App could provide rich autocomplete, but it's a totally different UX — opens a web view rather than staying in the composer.

**Limitations:** No custom trigger characters. You can't make `!` or `@` (without bot username) trigger autocomplete. The only native triggers are `/` and `@botname`.

### Slack API

Slack is more limited:

1. **`/` slash commands** — Register commands with your app, Slack shows the command in autocomplete with a static usage hint string. No dynamic argument completion — just the command name and a fixed description.

2. **Typeahead in interactive elements** — Slack supports dynamic typeahead (external data sources, `min_query_length`) but only inside Block Kit select menus within modals/dialogs/messages. This is interactive UI *inside messages*, not the composer bar.

3. **No composer bar API** — There is no public API to inject custom autocomplete suggestions into the Slack message input. The composer only autocompletes native triggers (`/commands`, `@mentions`, `#channels`, `:emoji:`).

**Limitations:** No custom trigger characters. No dynamic argument completion for slash commands. No way to add autocomplete to the composer beyond what Slack provides natively.

### Summary Table

| Feature | Telegram | Slack |
|---------|----------|-------|
| `/command` autocomplete | Dynamic, per-user | Static hint only |
| `@bot` inline query with live results | Yes | No equivalent |
| Custom trigger characters (`!`, `@`) | No | No |
| File path completion in composer | Possible via `@bot` inline mode | Not possible natively |
| Rich autocomplete via web view | Mini Apps | Block Kit modals (not in composer) |

## Decision

**Not pursuing.** The only platform with meaningful autocomplete capability (Telegram's inline mode) doesn't have an equivalent on Slack. Since ClearClaw targets both channels, building a feature that only works on one platform isn't worth the investment.

### What already works

- `/` commands show up in both Telegram and Slack's native command menus (to the extent ClearClaw registers them).

### If we revisited this

The escape hatch on both platforms would be a web-based UI (Telegram Mini Apps / Slack link unfurling to a web view), but that fundamentally changes the UX away from ClearClaw's design as a thin native-chat relay.
