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
| message:voice | Placeholder | Future: STT transcription |
| message:audio | Placeholder | Future: STT transcription |
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

## Future: audio

Same `Attachment` + download pipeline. Audio adds: detect audio MIME in orchestrator, call STT API (ElevenLabs/OpenAI), replace attachment with transcription text. Engine never sees audio.
