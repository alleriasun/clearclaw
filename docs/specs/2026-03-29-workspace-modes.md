# Workspace Modes: Assistant vs Relay

**Date:** 2026-03-29
**Status:** Implemented
**Depends on:** [Shared Layer](2026-03-18-shared-layer.md), [MCP Server](2026-03-28-mcp-server.md), [Identity Injection](2026-03-09-identity-injection.md)

## Context

ClearClaw started as a transparent relay — terminal-to-Telegram, everything forwarded as-is. But the personal assistant use case has been growing alongside it: identity injection, the home workspace, the shared layer spec. These are participant features, not relay features.

The tension became concrete with group chats. Every message from an allowed user triggers a full engine turn. Claude gets each message in isolation — it has no way to observe a conversation and choose not to respond. System-prompting Claude to "stay silent when appropriate" fails because each message arrives as its own dedicated turn.

This spec formalizes two workspace behaviors, adds infrastructure for natural conversation participation (including staying silent), and connects it to the shared layer.

## The Two Behaviors

### Assistant Mode

Claude is a **conversational participant**. The user is talking to a person, not operating a tool.

- **Display:** Tool internals hidden. No rolling status. Silent turns suppress the typing indicator entirely.
- **Timing:** Messages debounce and batch. A ~1s window accumulates incoming messages before triggering a turn.
- **Output:** Curated. A turn that internally did 5 tool calls produces one clean reply.
- **Engagement:** Claude can stay silent, react with emoji, reply to specific messages, or respond normally.
- **Permissions:** `bypassPermissions` by default — assistant acts autonomously. User can override with `/mode`.

### Relay Mode

Claude is a **remote terminal**. The user is operating Claude Code from their phone.

- **Display:** Transparent. Tool calls shown with rolling status. Permission prompts forwarded.
- **Timing:** Immediate. Queues messages if busy, drains on turn completion. No debounce.
- **Output:** Everything forwarded — tool results, diffs, status updates.
- **Engagement:** Always responds. No silent pass. Standard request-response.
- **Permissions:** Configured via `/mode` (default: prompts for everything).

### Defaults

Behavior is derived from workspace type and stored only when explicitly overridden:

| Workspace type | Default behavior |
|----------------|-----------------|
| Home (any chat) | Assistant |
| Project | Relay |

The home workspace is identified by `cwd === path.dirname(defaultPromptPath)`. Switchable per-workspace via the `/behavior` command.

## Key Design Decisions

### Behavior is display and routing, not identity

ClearClaw's core principle: **it does not model agents; the engine does.** Behavior only controls how ClearClaw wraps the interaction — what it shows, how it times messages, what channel capabilities it exposes. The same agent, same identity, same CLAUDE.md runs in both behaviors. Behavior is the envelope, not the letter.

This keeps ClearClaw as a relay. Assistant mode is a smarter relay that filters and batches, not an agent framework.

### One identity, everywhere

One CLAUDE.md (in the home workspace), one personality. The bot is one person who adapts to context naturally — a human doesn't have "different agents" for work vs friends, they read the room. A well-written CLAUDE.md handles contextual adaptation.

Identity injection (appending home CLAUDE.md to all sessions) continues to work as designed. This is the one place ClearClaw has an opinion about identity, and it's a thin, defensible one: "this is who you are."

### No managed workspace directories

Non-repo workspaces (assistant-mode group chats) share the home workspace's `cwd` (`~/.clearclaw/workspace/`). They don't need their own managed directories — they're the same agent in a different chat, not a different agent.

Multiple workspaces can point at the same `cwd`. The workspace table maps `chat_id → (name, cwd, session_id)`. Different chats get different sessions but the same home. Knowledge, notes, and files all live in one place — one brain, one home.

This avoids the managed-directory path that would push ClearClaw toward modeling agents (the OpenClaw direction). It also naturally solves shared memory: all assistant-mode workspaces see the same filesystem, so memory IS shared by default. No aggregation infrastructure needed.

Project workspaces continue to point at actual repos. They're the only ones with a distinct `cwd`.

## Message Flow

Both behaviors use the same queue infrastructure. The difference is drain timing:

- **Relay:** enqueue → drain immediately → one turn per queue snapshot
- **Assistant:** enqueue → reset debounce (~1s) → when timer fires, drain all queued messages into one batched turn

While a turn is running, new messages accumulate silently. After the turn completes, post-turn drain fires: relay drains immediately again, assistant starts a new debounce window.

No busy rejection in either mode — messages always queue.

### Batch Prompt Format

All turns use the same prompt format, regardless of batch size or behavior:

```
[msg:438] Alice (@alice): hey did anyone see the game last night?
[msg:439] Bob (@bob): yeah it was wild
[msg:440] Alice (@alice): that last minute goal though
[msg:441] Carol (@carol): @Yelia what do you think?
```

Single-message relay turns use the same format — `[msg:N] sender: text`.

### Message ID Plumbing

Each message's platform ID is available via `InboundMessage.messageId` (added in `feat/reply-context`). The prompt uses these IDs directly as `[msg:N]` tags. Participation tools reference the same ID — no index-to-ID mapping needed. ClearClaw passes the ID straight through to the channel when calling `reactToMessage` or `sendMessage` with `replyToMessageId`.

## Participation Tools (MCP)

New tools on the per-turn MCP server (alongside existing `send_file`). Available in assistant mode only. These are **channel capabilities** exposed to the engine — ClearClaw isn't deciding when to use them, the agent is.

### `stay_silent`

Claude calls this when it decides not to send a text response. ClearClaw suppresses all text output for the turn and skips the typing indicator.

```typescript
{ name: "stay_silent", inputSchema: { type: "object", properties: {} } }
```

### `react`

Send an emoji reaction to a specific message.

```typescript
{
  name: "react",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Platform message ID from [msg:N] tag." },
      emoji:   { type: "string", description: "Single emoji." }
    },
    required: ["message", "emoji"]
  }
}
```

### `reply_to`

Thread the text response as a reply to a specific message (Telegram quote, Slack thread).

```typescript
{
  name: "reply_to",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Platform message ID from [msg:N] tag." }
    },
    required: ["message"]
  }
}
```

### Composition

These compose naturally:
- `react("440", "🔥")` + `reply_to("441")` + text → React to msg 440, reply to msg 441 with text
- `react("439", "😂")` + `stay_silent()` → Just a reaction, no text
- `stay_silent()` → Complete silence
- Just text (no tools) → Unthreaded reply

All turns include `[msg:N]` tags regardless of batch size. The `message` parameter is always available.

### Channel Interface Changes

The `Channel` interface gains:
- `reactToMessage(chatId, platformMessageId, emoji)` — channel-agnostic, implemented for Telegram and Slack
- `sendMessage` gains optional `replyToMessageId` parameter for threading

## Display Layer

| Engine Event | Relay | Assistant |
|---|---|---|
| `tool_use` | Rolling status message | Suppressed |
| `tool_result` | Discarded | Discarded |
| `text` | Sent immediately | Sent (or suppressed if `stay_silent`) |
| `done` | Tool summary + status update | Status update only |
| `rate_limit` | Warning message | Warning message |
| `error` | Error message | Error message |
| Permission request | Full prompt + buttons | Bypassed (`bypassPermissions` default) |

## Workspace Schema

`behavior` is optional — stored only when explicitly overridden. Effective behavior is resolved at runtime:

```typescript
interface Workspace {
  name: string;
  cwd: string;
  chat_id: string;
  current_session_id: string | null;
  behavior?: "assistant" | "relay";  // explicit override; absent = derived from cwd
}
```

Resolved behavior: `ws.behavior ?? (isHomeWorkspace ? "assistant" : "relay")`.

Home workspace is identified by `ws.cwd === path.dirname(defaultPromptPath)`. Switchable at runtime via `/behavior`, persisted only when set explicitly.

## What This Doesn't Cover

- **Shared layer implementation** — Memory tools, hook injection. See [shared layer spec](2026-03-18-shared-layer.md).
- **Voice/audio transcription** — Currently placeholder text. Separate feature.
- **Proactive messaging** — Bot initiating without a trigger. Architecturally different.
- **Multi-bot groups** — Multiple ClearClaw instances. Out of scope.
