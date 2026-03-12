# Plan: Slack channel — second delivery channel

## Why

ClearClaw only speaks Telegram. Slack is the natural second channel — same relay, different surface. Architecture already has the primitives: `ownsId()`, prefixed chat IDs, Channel interface.

## Research

**NanoClaw** — `@slack/bolt` + Socket Mode. Text-only (no buttons/edits/pins). Good baseline.
**OpenClaw** — Full Block Kit, `chat.update`, pins, emoji reactions for ack, `assistant.threads.setStatus` for typing.

Key findings: Button clicks have **no built-in expiry** (our 30-min is our own cleanup). `pins.list` needs user tokens. No bot typing API but emoji reactions work. `conversations.setTopic` is always-visible in channel header (250 chars, emoji ok).

## Decisions

**Single channel** — one at a time (TG or Slack), not both. Multi-channel routing deferred.

**setTyping** — `reactions.add("eyes")` on user's message at turn start, remove when done. Track inbound `ts` per chat.

**Formatting** — channel concern. Orchestrator sends universal markdown. Each channel converts (`escapeMarkdownV2` moves into `telegram.ts`). `parseMode` drops from `SendInteractiveOpts`.

**sendInteractive** — Block Kit section + actions. `action_id`: `ccb:<uuid>:<idx>`. `app.action(/^ccb:/)` listener. `requestText` captures next message.

**Status bar** — pins are in a separate Slack tab now. Use `conversations.setTopic` instead — always visible. Suppress "topic changed" system messages by deleting them.

## Files

**New:** `src/channel/slack.ts` (~290 lines) — full Channel impl
**Modified:** `config.ts`, `format.ts`, `telegram.ts`, `types.ts`, `index.ts`, `orchestrator.ts`
**Deps:** `@slack/bolt`
**Docs:** CLAUDE.md, TASKS.md, ARCHITECTURE.md

## Status

Implemented. Key changes beyond the Slack channel itself:

- **format.ts** — outputs universal markdown; `escapeMarkdownV2` removed (moved to telegram.ts)
- **telegram.ts** — absorbed `escapeMarkdownV2` + added `convertToMarkdownV2` for code-fence-aware escaping; `sendInteractive` handles MarkdownV2 conversion internally with plain-text fallback
- **types.ts** — dropped `SendInteractiveOpts` (formatting is a channel concern, not an orchestrator concern)
- **config.ts** — `ChannelConfig` discriminated union (TelegramConfig | SlackConfig); Slack env vars take priority if both are set
- **index.ts** — channel factory based on `config.channel.type`

Not yet tested end-to-end with a live Slack workspace.
