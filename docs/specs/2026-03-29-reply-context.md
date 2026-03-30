# Reply Context

## Problem

When a user replies to or quotes a message in Telegram (or threads in Slack), ClearClaw drops the context entirely. Only the new message text is captured. The LLM has no idea what the user is responding to, breaking conversational flow in group chats.

## Platform Mechanics

**Telegram:** `reply_to_message` is a full `Message` object on the event — includes `message_id`, `from` (sender), `text`, `caption`, `photo`, `document`, etc. Points to the specific message being replied to. Any-to-any reply graph.

**Slack:** `thread_ts` on the event points to the thread parent (root message). All replies in a thread share the same `thread_ts` regardless of which message in the thread prompted the reply. Flat structure under a root — no specific-message targeting like Telegram. Parent message content requires a `conversations.history` API call; it's not inline in the event.

**Key similarity:** Despite different UX (Telegram = quote bubbles, Slack = thread sidebar), both boil down to "this message references that other message." ClearClaw can abstract them the same way.

## Design Decisions

### Message IDs on every inbound message

Every `InboundMessage` gets tagged with its platform message ID (Telegram `message_id`, Slack `ts`). This is free — both platforms include it in the event payload already. The model can then cross-reference reply context IDs with messages it has already seen in the session.

This solves the "reply to a captionless image" problem elegantly: if the model saw the image earlier in the session, the message ID lets it connect the reply back to it without re-downloading anything.

### Reply context: text + metadata, no media re-download

When a message is a reply, include the referenced message's ID, sender name, text/caption, and media type hint. Do not re-download quoted images or other media.

**Considered and rejected:**
- **Re-downloading quoted media**: Adds latency and bandwidth cost on every reply-to-media message. The model already saw the image if it was sent earlier in the same session. The message ID reference is sufficient. Can be added later if the "reply to captionless image from before the session" case proves painful.
- **Truncating quoted text**: The platforms already enforce message length limits (Telegram 4096 chars, Slack 3000 chars), so quoted text is naturally bounded. No additional truncation needed.
- **Just the message ID, no text**: Would force the model to always look back in context. Including the text is cheap and makes the common case (text reply to text) work without any context-hunting.

### Prompt formatting (LLM-only)

Reply context is prepended to the prompt string, visible only to the LLM. Nothing is sent back to the channel. Format:

```
[Replying to Bob msg:4827 [photo] "Homepage preview"]
[Paddy (@fateakong) (msg:4831)]: I like the first version
```

For the default (DM) workspace, sender identity is still skipped (it's always the owner), but reply context and message ID are included when present.

### No thread management

ClearClaw does not manage thread visualization, conversation trees, or multi-message thread context. Just the single parent/quoted message reference. This is a relay, not a conversation manager.

## Scope

**In scope:**
- `InboundMessage` gets `messageId` (optional string) and `replyTo` (optional `ReplyContext`)
- `ReplyContext`: `messageId`, `senderName?`, `text?`, `mediaType?`
- Telegram: extract from `reply_to_message` in all message handlers (text, photo, document, unsupported media)
- Slack: extract from `thread_ts` + `conversations.history` call for parent content
- Orchestrator: format reply context into prompt for all workspaces (including default/DM — replying to a specific bot response to say "expand on this" is useful context even in a 1:1 conversation)
- Message IDs on all workspaces

**Out of scope:**
- Re-downloading quoted media
- Thread conversation history (multiple messages)
- Any channel-bound output (reply context is prompt-only)
