# Reply Context Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan.

**Goal:** Surface reply/quote context from Telegram and Slack thread replies into the LLM prompt so the model knows what a message is responding to.

**Architecture:** Add `messageId` and optional `replyTo` to `InboundMessage`. Each channel extracts platform-native reply data (Telegram `reply_to_message`, Slack `thread_ts` + parent fetch). Orchestrator formats reply context into the prompt string — purely for the LLM, nothing sent back to channels.

**Tech Stack:** TypeScript, grammY (Telegram), Slack Bolt

**Spec:** `docs/specs/2026-03-29-reply-context.md`

**Note:** No test infrastructure exists in this project. Verification is via `npm run check` (type check) and `npm run build`.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/types.ts` | Modify | Add `ReplyContext` interface, add `messageId` and `replyTo` to `InboundMessage` |
| `src/channel/telegram.ts` | Modify | Extract `message_id` and `reply_to_message` from all message handlers |
| `src/channel/slack.ts` | Modify | Extract `ts` and fetch thread parent for `thread_ts` replies |
| `src/orchestrator.ts` | Modify | Format reply context + message ID into prompt string |

---

## Chunk 1: Types and Telegram

### Task 1: Add ReplyContext and messageId to InboundMessage

**Files:**
- Modify: `src/types.ts:142-149`

- [ ] **Step 1: Add ReplyContext interface above InboundMessage**

Insert before the `InboundMessage` interface (line 144):

```typescript
/** Context from a replied-to / quoted message. */
export interface ReplyContext {
  messageId: string;
  senderName?: string;
  text?: string;
  mediaType?: string;  // "photo" | "document" | "video" | "voice" | "audio" | "sticker" | "animation"
}
```

- [ ] **Step 2: Add messageId and replyTo to InboundMessage**

The existing `InboundMessage` (line 144) is:
```typescript
export interface InboundMessage {
  chatId: string;
  user: UserInfo;
  text: string;
  attachments?: Attachment[];
}
```

Change it to:
```typescript
export interface InboundMessage {
  chatId: string;
  user: UserInfo;
  text: string;
  messageId?: string;
  replyTo?: ReplyContext;
  attachments?: Attachment[];
}
```

- [ ] **Step 3: Verify types**

Run: `npm run check`
Expected: PASS (new fields are optional, no consumers break)

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat: add messageId and ReplyContext to InboundMessage"
```

---

### Task 2: Extract reply context in Telegram channel

**Files:**
- Modify: `src/channel/telegram.ts`

**Context:** Handlers that emit `InboundMessage`:
1. `message:text` (line 40) — emits line 52
2. `message:photo` (line 58) — via `handleFileMessage` (line 335)
3. `message:document` (line 65) — via `handleFileMessage`
4. Unsupported media loop (line 76)

grammY: `ctx.message.reply_to_message` is a full `Message` with `message_id`, `from`, `text`, `caption`, `photo`, `document`, etc.

- [ ] **Step 1: Add `ReplyContext` to imports from `../types.js`**

- [ ] **Step 2: Add `extractReplyContext` private method**

After `extractSender` (line 332). Uses structural typing for the param — no grammY type imports needed. Checks `reply_to_message` for: `message_id`, `from` (→ `senderName`), `text` / `caption` (→ `text`), and media fields `photo|document|video|voice|audio|sticker|animation` (→ `mediaType`). Returns `ReplyContext | undefined`.

- [ ] **Step 3: Update `message:text` handler (line 52)**

Add `messageId: String(ctx.message.message_id)` and `replyTo: this.extractReplyContext(ctx.message)` to the emit.

- [ ] **Step 4: Update `handleFileMessage` (line 335)**

After `extractSender`, extract `messageId` and `replyTo` from `ctx.message`. Add both to the success and error emit paths.

- [ ] **Step 5: Update unsupported media loop (line 76)**

Add `messageId: ctx.message ? String(ctx.message.message_id) : undefined` and `replyTo: ctx.message ? this.extractReplyContext(ctx.message) : undefined` to the emit. (The spec explicitly includes unsupported media in scope — the reply context tells the model what the user was responding to, even if the new message itself is unsupported media.)

- [ ] **Step 6: `npm run check` — expected PASS**

- [ ] **Step 7: Commit**

```bash
git add src/channel/telegram.ts
git commit -m "feat: extract messageId and reply context in Telegram channel"
```

---

## Chunk 2: Slack and Orchestrator

### Task 3: Extract reply context in Slack channel

**Files:**
- Modify: `src/channel/slack.ts`

**Context:** Slack uses `thread_ts` for thread replies. It points to the thread parent (root message). Parent content requires a `conversations.history` API call. The inline type cast at line 44 needs `thread_ts` added. Guard: if `thread_ts === ts`, it's the parent itself — not a reply.

- [ ] **Step 1: Add `ReplyContext` to imports from `../types.js`**

- [ ] **Step 2: Add `thread_ts` to the inline type cast (line 44)**

```typescript
const msg = event as {
  channel: string; user?: string; bot_id?: string;
  text?: string; ts: string; thread_ts?: string;
  files?: Array<{ url_private_download?: string; mimetype?: string; name?: string }>;
};
```

- [ ] **Step 3: Add `fetchReplyContext` private method**

Takes `channel`, `threadTs`, `ownTs`. If `threadTs === ownTs`, return undefined (it's the parent, not a reply). Otherwise call `conversations.history` with `latest: threadTs, limit: 1, inclusive: true` to get the parent. Extract `text`, sender name (via `resolveUserName`), and `mediaType` from files. Wrap in try/catch — log warning on failure, return undefined.

- [ ] **Step 4: Wire into the message emit (around line 87)**

Before the emit, if `msg.thread_ts` is present, `await` the `fetchReplyContext` call. Add `messageId: msg.ts` and `replyTo` to the emit:

```typescript
const replyTo = msg.thread_ts
  ? await this.fetchReplyContext(msg.channel, msg.thread_ts, msg.ts)
  : undefined;
```

Note: The `/cc` slash command handler (line 105) does not get `messageId` or `replyTo` — Slack command payloads don't carry a message `ts` or thread context. Intentionally left as-is.

- [ ] **Step 5: `npm run check` — expected PASS**

- [ ] **Step 6: Commit**

```bash
git add src/channel/slack.ts
git commit -m "feat: extract messageId and reply context in Slack channel"
```

---

### Task 4: Format reply context in orchestrator prompt

**Files:**
- Modify: `src/orchestrator.ts:243-245`

**Context:** Current prompt construction (line 243-245):
```typescript
const sender = msg.user.handle ? `${msg.user.name} (@${msg.user.handle})` : msg.user.name;
const prompt = isDefaultWorkspace ? msg.text : `[${sender}]: ${msg.text}`;
```

- [ ] **Step 1: Add a `formatReplyLine` helper**

Add as a module-level function (near the bottom of the file, alongside other helpers like `formatPermissionPrompt`). Output format matches the spec exactly:

```typescript
function formatReplyLine(replyTo?: ReplyContext): string {
  if (!replyTo) return "";
  const parts: string[] = [];
  if (replyTo.senderName) parts.push(replyTo.senderName);
  parts.push(`msg:${replyTo.messageId}`);
  if (replyTo.mediaType) parts.push(`[${replyTo.mediaType}]`);
  if (replyTo.text) parts.push(`"${replyTo.text}"`);
  return `[Replying to ${parts.join(" ")}]\n`;
}
```

Examples:
- All fields: `[Replying to Bob msg:4827 [photo] "Homepage preview"]\n`
- No sender/text: `[Replying to msg:4827 [photo]]\n`
- Text only: `[Replying to Bob msg:4827 "Sure sounds good"]\n`
- No replyTo: `""`

Import `ReplyContext` from `../types.js` at the top of the file.

- [ ] **Step 2: Update prompt construction**

Replace the two-line block with:

```typescript
const sender = msg.user.handle ? `${msg.user.name} (@${msg.user.handle})` : msg.user.name;
const msgIdTag = msg.messageId ? ` (msg:${msg.messageId})` : "";
const replyLine = formatReplyLine(msg.replyTo);

let prompt: string;
if (isDefaultWorkspace) {
  prompt = `${replyLine}${msg.text}`;
} else {
  prompt = `${replyLine}[${sender}${msgIdTag}]: ${msg.text}`;
}
```

Default workspace: reply context + raw text (no sender decoration).
Group workspace: reply context + sender tag with message ID.

- [ ] **Step 3: `npm run check` — expected PASS**

- [ ] **Step 4: `npm run build` — expected clean compilation**

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: format reply context into LLM prompt"
```
