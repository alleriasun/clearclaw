# File & Image Sharing (Inbound)

**Date:** 2026-03-14
**Status:** In progress

---

## Context

ClearClaw only handles text messages today. The Claude Agent SDK natively supports image and document content blocks via `MessageParam`. This plan adds inbound file/image sharing — downloading from chat platforms and passing to the SDK.

This also builds shared plumbing (download, save) that audio/voice will reuse later with an added STT step.

### Reference implementations

- **NanoClaw** -- text placeholders (`[Photo]`, `[Document: x.pdf]`). No downloads.
- **OpenClaw** -- full pipeline, `~/.openclaw/media/inbound/`, `{name}---{uuid}.{ext}` naming.
- **RemoteCode** -- downloads, base64-encodes, passes as image content blocks. Closest match.

---

## Design Decisions

### Storage

`{dataDir}/files/` (i.e. `~/.clearclaw/files/`). Single shared folder, not per-workspace -- avoids polluting workspace `cwd` dirs (typically checked-in repos). Directory created at startup by `loadConfig()` alongside the base `dataDir`.

**Naming:** `{workspace}-{epoch_secs}-{hex4}-{original_filename}` -- e.g. `clearclaw-1710432000-a3f2-screenshot.jpg`. Workspace prefix for grouping, timestamp for ordering, 4-char random hex suffix to prevent collisions when multiple files arrive in the same second (especially with parallel Slack downloads), original name for readability.

**No cleanup.** Files are small (images, PDFs) and serve as a natural log.

### Two-type attachment model

Channels don't know the workspace name — only the orchestrator does (via `workspaceStore.byChat()`). This drives a two-type design:

- **`RawAttachment`** — `{ buffer, mimeType, filename? }`. Channel populates after downloading from its platform API. Lives on `InboundMessage`.
- **`Attachment`** — `{ path, buffer, mimeType, filename? }`. Orchestrator creates by calling `saveFile()` after resolving the workspace. Carries the buffer forward so the engine can encode from memory without re-reading from disk. Lives on `RunTurnOpts`.

```ts
export interface RawAttachment {
  buffer: Buffer;
  mimeType: string;
  filename?: string;
}

export interface Attachment {
  path: string;        // absolute path in files/
  buffer: Buffer;      // original data, avoids re-reading from disk
  mimeType: string;    // e.g. "image/jpeg", "application/pdf"
  filename?: string;   // original filename from the platform
}
```

### SDK integration

Engine builds `MessageParam.content` array when attachments present. Without attachments, behavior unchanged (plain string prompt).

`query()` accepts `prompt: string | AsyncIterable<SDKUserMessage>`. For attachments, construct `SDKUserMessage` with content block array via the `AsyncIterable` path.

**MIME type handling** — broad prefix matching, no exhaustive registry. Channels produce whatever MIME the platform gives them; the engine does simple routing:

| MIME pattern | SDK block | Notes |
|-----------|-----------|-------|
| `image/*` | image (base64) | API rejects unsupported subtypes at runtime — fine, they're rare in chat |
| `application/pdf` | document (base64) | PDF understanding |
| `text/*` | text (file contents) | Inline with filename header |
| Anything else | text placeholder | `[Unsupported file: {name}]` |

This keeps channels and engine fully decoupled — no shared MIME registry needed. If the API adds support for new types, the engine picks them up automatically.

**Type safety:** `@anthropic-ai/sdk` added as a devDependency for `MessageParam` and content block types. Replaces `any` escape hatches in `buildAttachmentPrompt` / `encodeAttachment`.

### Telegram

| Event | Attachment? | Notes |
|-------|-------------|-------|
| message:photo | Yes | Download largest size. Always JPEG (Telegram re-encodes). |
| message:document | Yes | Download, use platform-provided MIME + filename |
| message:video | Placeholder | SDK doesn't support video |
| message:voice | Yes | Transcribed at ingress ([decision](#decision-audio-is-transcribed-at-ingress)). MIME defaults to `audio/ogg` |
| message:audio | Yes | Transcribed at ingress. Platform-provided MIME + filename |
| message:sticker | Placeholder | Low value |

Captions become `text` on `InboundMessage`. Unsupported types emit placeholder text (e.g. `[Voice message]`) -- better than silently dropping.

Photo and document handlers share a private `handleMediaMessage()` helper — the download/emit/fallback pattern is identical, only metadata extraction differs.

File download uses `bot.api.getFile()` for the file path, then `fetch()` against the Telegram file URL. No built-in grammY download helper exists.

### Slack

Check `event.files[]` on messages. Download via `url_private_download` with Bearer auth. Multiple files in one message are downloaded in parallel (`Promise.allSettled`).

### Async I/O

All file operations (`saveFile`, `encodeAttachment`) use `fs/promises` — synchronous I/O blocks the event loop and would stall all chats during large file saves/reads.

---

## File changes

| File | Changes |
|------|---------|
| src/types.ts | Add `RawAttachment`, `Attachment` (with buffer). Extend `InboundMessage` + `RunTurnOpts` |
| src/files.ts | **New.** `saveFile()` (async), filename sanitization, random suffix |
| src/channel/telegram.ts | `extractSender()`, `downloadFile()`, `handleMediaMessage()` helper. Photo/document/placeholder handlers |
| src/channel/slack.ts | `downloadFile()` with Bearer auth. Parallel `event.files[]` download. Accept `file_share` subtype |
| src/orchestrator.ts | `dataDir` field. Save raw attachments via `saveFile()`, pass `Attachment[]` to engine |
| src/engine/claude-code.ts | `encodeAttachment()` with prefix-based MIME routing, `buildAttachmentPrompt()` via `AsyncIterable<SDKUserMessage>` |
| src/config.ts | Create `files/` dir at startup |
| src/index.ts | Pass `dataDir` to orchestrator |

## Decision: audio is transcribed at ingress

**Status:** Accepted (2026-10)

### Context

Users send voice notes from their phones. No engine consumes audio, and ClearClaw runs on the user's subscriptions rather than API keys, so a paid STT API would be a new account and a new secret.

### Decision

Audio arrives through the same `Attachment` download pipeline (Telegram `message:voice` / `message:audio`, any `audio/*` file from Slack). The orchestrator transcribes it as soon as an authorized message arrives, before routing, debounce, or batching:

- **Provider:** the Claude.ai speech-to-text stream that Claude Code's `/voice` dictation uses. It is an undocumented WebSocket endpoint, authenticated with the Claude.ai OAuth token Claude Code already stores on the host (Keychain on macOS, `~/.claude/.credentials.json` elsewhere). Anthropic's dictation docs state it counts against no Claude usage limits. The stream takes raw 16 kHz PCM, so the audio is decoded with `ffmpeg` first.
- **Message shape:** the transcript becomes the message text (after the caption, if any). The audio attachment is removed, so the engine never sees audio and it is not saved to `files/`.
- **Echo:** the chat receives `🎙 heard: <transcript>` before the turn, so a misheard instruction is visible before the agent acts on it.
- **Failure:** missing credentials, a missing or failing `ffmpeg`, a stream error, a timeout, or an empty transcript all degrade to the text `[Voice message — transcription failed]`. The turn still runs, and there is no echo.

### Alternatives considered

- **Codex / ChatGPT `backend-api/transcribe`:** blocked by a Cloudflare browser challenge for non-browser clients.
- **Codex app-server realtime:** requires an API key or WebRTC, and is paced in real time, so a 30 s note takes 30 s.
- **Local whisper.cpp:** no network or account dependency, at the cost of a local model to install. Deferred as a possible fallback provider.

### Consequences

- `ffmpeg` is a runtime requirement for voice input. Without it, voice notes degrade to the placeholder.
- The endpoint is undocumented and may change or break without notice. Failure degrades visibly rather than silently, and the transcription boundary (`src/transcribe.ts`) is the only code that knows about it.
- Transcription only works on hosts where Claude Code is logged in with a Claude.ai account.
- A voice note and a text message sent right after it in the same chat can reach the queue out of order, because transcription takes a few seconds.
