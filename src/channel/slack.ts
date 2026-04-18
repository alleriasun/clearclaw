import { EventEmitter } from "node:events";
import { App, LogLevel } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import type { MessageElement } from "@slack/web-api/dist/types/response/ConversationsHistoryResponse.js";
import { slackifyMarkdown } from "slackify-markdown";
import log from "../logger.js";
import type { Attachment, Channel, ChatType, Button, ButtonResponse, ReplyContext, SendFileOpts, MessageOpts, UserInfo } from "../types.js";

export class SlackChannel extends EventEmitter implements Channel {
  name = "slack";

  private static readonly EMOJI_TO_SLACK: Record<string, string> = {
    "👍": "+1", "👎": "-1", "❤️": "heart", "🔥": "fire",
    "😂": "joy", "🎉": "tada", "✅": "white_check_mark", "🚀": "rocket",
    "👀": "eyes", "💯": "100", "🤔": "thinking_face", "😮": "open_mouth",
    "🙏": "pray", "💪": "muscle", "⚡": "zap", "🌟": "star2",
  };

  private app: App;
  private botToken: string;
  private botUserId: string | undefined;
  private isAuthorized: (userId: string) => boolean;
  private onUnauthorizedDM?: (chatId: string, user: UserInfo) => void;
  private pendingButtonCallbacks = new Map<string, (triggerId: string) => void>(); // actionId → resolve
  private pendingModalCallbacks = new Map<string, (text: string) => void>(); // modal callbackId → resolve
  private typingMessageTs = new Map<string, string>(); // chatId → ts of bot's "typing…" placeholder
  private userNameCache = new Map<string, string>();

  constructor(
    botToken: string,
    appToken: string,
    isAuthorized: (userId: string) => boolean,
    onUnauthorizedDM?: (chatId: string, user: UserInfo) => void,
  ) {
    super();
    this.botToken = botToken;
    this.isAuthorized = isAuthorized;
    this.onUnauthorizedDM = onUnauthorizedDM;
    this.app = new App({
      token: botToken, appToken, socketMode: true, logLevel: LogLevel.ERROR,
    });
  }

  async connect(): Promise<void> {
    this.app.event("message", async ({ event }) => {
      const subtype = (event as { subtype?: string }).subtype;

      // Suppress topic-change system messages from our setTopic calls
      if (subtype === "channel_topic" || subtype === "group_topic") {
        const ts = (event as { ts: string }).ts;
        try {
          await this.app.client.chat.delete({ channel: event.channel, ts });
        } catch { /* may lack permission */ }
        return;
      }

      if (subtype && subtype !== "bot_message" && subtype !== "file_share") return;
      // Bolt's message event is a union of many subtypes with different shapes;
      // inline type is simpler than importing and narrowing the full union.
      const msg = event as {
        channel: string; user?: string; bot_id?: string;
        text?: string; ts: string; thread_ts?: string;
        files?: Array<{ url_private_download?: string; mimetype?: string; name?: string }>;
      };

      const chatId = `slack:${msg.channel}`;
      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;
      if (isBotMessage) return;

      // Need either text or files to proceed
      if (!msg.text && (!msg.files || msg.files.length === 0)) return;

      const userId = msg.user;
      if (!userId) return;
      const prefixedId = `slack:${userId}`;
      if (!this.isAuthorized(prefixedId)) {
        // Slack DM channel IDs start with "D"
        if (msg.channel.startsWith("D") && this.onUnauthorizedDM) {
          const userName = await this.resolveUserName(userId);
          this.onUnauthorizedDM(chatId, { id: prefixedId, name: userName ?? userId });
        } else {
          log.info("[channel] ignored message from unauthorized user %s", prefixedId);
        }
        return;
      }

      // Download attached files in parallel
      let attachments: Attachment[] | undefined;
      if (msg.files?.length) {
        const downloadable = msg.files.filter((f) => f.url_private_download);
        if (downloadable.length > 0) {
          const results = await Promise.allSettled(
            downloadable.map(async (file) => {
              const buffer = await this.downloadFile(file.url_private_download!);
              return { buffer, mimeType: file.mimetype ?? "application/octet-stream", filename: file.name } as Attachment;
            }),
          );
          const succeeded = results
            .filter((r): r is PromiseFulfilledResult<Attachment> => r.status === "fulfilled")
            .map((r) => r.value);
          for (const r of results) {
            if (r.status === "rejected") {
              log.warn({ err: r.reason }, "[channel] failed to download Slack file");
            }
          }
          if (succeeded.length > 0) attachments = succeeded;
        }
      }

      const replyTo = msg.thread_ts
        ? await this.fetchReplyContext(msg.channel, msg.thread_ts, msg.ts)
        : undefined;

      const chatType: ChatType = msg.channel.startsWith("D") ? "dm" : "group";

      const userName = await this.resolveUserName(userId);
      this.emit("message", {
        chatId,
        chatType,
        user: { id: prefixedId, name: userName ?? userId },
        text: msg.text ?? "",
        messageId: msg.ts,
        replyTo,
        ...(attachments && { attachments }),
      });
    });

    // Handle button presses from sendInteractive
    this.app.action(/^ccb:/, async ({ action, body, ack }) => {
      await ack();
      const actionId = (action as { action_id: string }).action_id;
      const triggerId = (body as { trigger_id?: string }).trigger_id ?? "";
      const resolve = this.pendingButtonCallbacks.get(actionId);
      if (resolve) resolve(triggerId);
    });

    // Handle /cc slash command — emit as /<subcommand> so orchestrator handles it
    this.app.command("/cc", async ({ command, ack }) => {
      await ack();
      const subcommand = command.text.trim();
      if (!subcommand) return;
      const chatId = `slack:${command.channel_id}`;
      const userId = command.user_id;
      if (!this.isAuthorized(`slack:${userId}`)) return;
      const chatType: ChatType = command.channel_id.startsWith("D") ? "dm" : "group";
      const userName = await this.resolveUserName(userId);
      this.emit("message", {
        chatId,
        chatType,
        user: { id: `slack:${userId}`, name: userName ?? userId },
        text: `/${subcommand}`,
      });
    });

    // Handle modal submissions from "Deny + Note" feedback
    this.app.view(/^ccv:/, async ({ view, ack }) => {
      await ack();
      const feedbackValue = view.state?.values?.feedback_block?.feedback_input?.value ?? "";
      const resolve = this.pendingModalCallbacks.get(view.callback_id);
      if (resolve) {
        this.pendingModalCallbacks.delete(view.callback_id);
        resolve(feedbackValue);
      }
    });

    await this.app.start();

    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      log.info("[channel] Slack bot: %s", this.botUserId);
    } catch {
      log.warn("[channel] Connected to Slack but failed to get bot user ID");
    }
  }
  async disconnect(): Promise<void> {
    // Delete lingering typing placeholder messages
    for (const [chatId, ts] of this.typingMessageTs) {
      try {
        await this.app.client.chat.delete({ channel: this.slackId(chatId), ts });
      } catch { /* already deleted or no permission */ }
    }
    this.typingMessageTs.clear();
    await this.app.stop();
  }
  ownsId(chatId: string): boolean { return chatId.startsWith("slack:"); }
  async sendMessage(
    chatId: string,
    text: string,
    opts?: MessageOpts,
  ): Promise<string[]> {
    const channel = this.slackId(chatId);
    const chunks = splitMessage(text);
    const handles: string[] = [];
    const threadTs = opts?.replyToMessageId;

    const plain = opts?.format === "plain";

    /** Post a chunk, with mrkdwn blocks unless plain format requested. */
    const postChunk = async (chunk: string, extra: Record<string, unknown> = {}): Promise<string | undefined> => {
      if (plain) {
        const r = await this.app.client.chat.postMessage({ channel, text: chunk, ...extra });
        return r.ts as string | undefined;
      }
      const blocks = mrkdwnBlocks(chunk);
      try {
        const r = await this.app.client.chat.postMessage({ channel, text: chunk, blocks, ...extra });
        return r.ts as string | undefined;
      } catch {
        log.warn("[channel] postMessage failed with mrkdwn, retrying as plain text");
        const r = await this.app.client.chat.postMessage({ channel, text: chunk, ...extra });
        return r.ts as string | undefined;
      }
    };

    // Consume typing placeholder only when not posting as a thread reply
    const consumeTyping = !threadTs && opts?.consumeTyping !== false;
    const typingTs = consumeTyping ? this.typingMessageTs.get(chatId) : undefined;
    if (typingTs && chunks.length > 0) {
      this.typingMessageTs.delete(chatId);
      const firstChunk = chunks.shift()!;
      if (plain) {
        try {
          await this.app.client.chat.update({ channel, ts: typingTs, text: firstChunk });
          handles.push(typingTs);
        } catch {
          const ts = await postChunk(firstChunk);
          if (ts) handles.push(ts);
        }
      } else {
        const blocks = mrkdwnBlocks(firstChunk);
        try {
          await this.app.client.chat.update({
            channel, ts: typingTs, text: firstChunk, blocks,
          });
          handles.push(typingTs);
        } catch {
          const ts = await postChunk(firstChunk);
          if (ts) handles.push(ts);
        }
      }
    }

    for (const chunk of chunks) {
      const ts = await postChunk(chunk, threadTs ? { thread_ts: threadTs } : {});
      if (ts) handles.push(ts);
    }
    return handles;
  }

  async sendInteractive(
    chatId: string,
    text: string,
    buttons: Button[][],
  ): Promise<ButtonResponse> {
    const channel = this.slackId(chatId);
    const callbackId = crypto.randomUUID().slice(0, 8);

    // Pre-compute action IDs mapped to buttons
    const actionEntries: { btn: Button; actionId: string }[] = [];
    let idx = 0;
    for (const row of buttons) {
      for (const btn of row) {
        actionEntries.push({ btn, actionId: `ccb:${callbackId}:${idx++}` });
      }
    }

    const blocks: KnownBlock[] = [
      mrkdwnBlocks(splitMessage(text)[0])[0],
      {
        type: "actions",
        elements: actionEntries.map(({ btn, actionId }) => ({
          type: "button" as const,
          text: { type: "plain_text" as const, text: btn.label },
          action_id: actionId,
          value: btn.value,
        })),
      },
    ];

    const result = await this.app.client.chat.postMessage({
      channel, text, blocks,
    });

    const cleanupAll = () => {
      for (const { actionId } of actionEntries) {
        this.pendingButtonCallbacks.delete(actionId);
      }
    };

    // Wait for button press (no timeout — matches CLI behavior)
    const { button: pressed, triggerId } = await new Promise<{ button: Button; triggerId: string }>((resolve) => {
      for (const entry of actionEntries) {
        this.pendingButtonCallbacks.set(entry.actionId, (triggerId) => {
          cleanupAll();
          resolve({ button: entry.btn, triggerId });
        });
      }
    });

    // Update message to highlight the selected button (others become inert — no callbacks)
    if (result.ts) {
      const feedbackBlocks: KnownBlock[] = [
        blocks[0],
        {
          type: "actions",
          elements: actionEntries.map(({ btn, actionId }) => ({
            type: "button" as const,
            text: { type: "plain_text" as const, text: btn === pressed ? `✅ ${btn.label}` : btn.label },
            action_id: actionId,
            value: btn.value,
          })),
        },
      ];
      try {
        await this.app.client.chat.update({
          channel, ts: result.ts as string, text, blocks: feedbackBlocks,
        });
      } catch { /* best-effort */ }
    }

    if (pressed.requestText && triggerId) {
      // Open a modal for feedback input (Slack equivalent of Telegram's force_reply)
      const modalCallbackId = `ccv:${callbackId}`;
      await this.app.client.views.open({
        trigger_id: triggerId,
        view: {
          type: "modal",
          callback_id: modalCallbackId,
          title: { type: "plain_text", text: "Deny with note" },
          submit: { type: "plain_text", text: "Submit" },
          blocks: [
            {
              type: "input",
              block_id: "feedback_block",
              element: {
                type: "plain_text_input",
                action_id: "feedback_input",
                multiline: true,
                placeholder: { type: "plain_text", text: "Why are you denying this action?" },
              },
              label: { type: "plain_text", text: "Note" },
            },
          ],
        },
      });
      const followUpText = await new Promise<string>((resolve) => {
        this.pendingModalCallbacks.set(modalCallbackId, resolve);
      });
      if (followUpText && result.ts) {
        try {
          await this.app.client.chat.postMessage({
            channel,
            text: `Denied with note:\n> ${followUpText}`,
            thread_ts: result.ts as string,
          });
        } catch { /* best-effort */ }
      }
      return { value: pressed.value, text: followUpText };
    }

    return { value: pressed.value };
  }

  async editMessage(chatId: string, handle: string, text: string, opts?: MessageOpts): Promise<void> {
    const chunk = splitMessage(text)[0];
    if (opts?.format === "plain") {
      await this.app.client.chat.update({
        channel: this.slackId(chatId),
        ts: handle,
        text: chunk,
      });
    } else {
      await this.app.client.chat.update({
        channel: this.slackId(chatId),
        ts: handle,
        text: chunk,
        blocks: mrkdwnBlocks(chunk),
      });
    }
  }

  async deleteMessage(chatId: string, handle: string): Promise<void> {
    await this.app.client.chat.delete({
      channel: this.slackId(chatId),
      ts: handle,
    });
  }

  async pinMessage(chatId: string, handle: string): Promise<void> {
    await this.app.client.pins.add({
      channel: this.slackId(chatId),
      timestamp: handle,
    });
  }

  async unpinAllMessages(chatId: string): Promise<void> {
    const channel = this.slackId(chatId);
    try {
      const result = await this.app.client.pins.list({ channel });
      if (result.items) {
        for (const item of result.items) {
          // The Slack API returns message.ts on pinned messages but the type defs omit it
          const ts = (item as { message?: { ts?: string } }).message?.ts;
          if (ts) {
            await this.app.client.pins.remove({ channel, timestamp: ts });
          }
        }
      }
    } catch { /* may not have permission */ }
  }

  async updateStatus(chatId: string, text: string): Promise<void> {
    await this.app.client.conversations.setTopic({
      channel: this.slackId(chatId),
      topic: text,
    });
  }

  async setTyping(chatId: string, isTyping: boolean): Promise<void> {
    const channel = this.slackId(chatId);

    if (isTyping) {
      if (this.typingMessageTs.has(chatId)) return;
      try {
        const result = await this.app.client.chat.postMessage({
          channel, text: "_typing…_",
        });
        if (result.ts) this.typingMessageTs.set(chatId, result.ts as string);
      } catch { /* best-effort */ }
    } else {
      // Delete placeholder if it wasn't consumed by sendMessage
      const ts = this.typingMessageTs.get(chatId);
      if (ts) {
        this.typingMessageTs.delete(chatId);
        try {
          await this.app.client.chat.delete({ channel, ts });
        } catch { /* already deleted */ }
      }
    }
  }

  async sendFile(chatId: string, buffer: Buffer, filename: string, opts?: SendFileOpts): Promise<void> {
    const channel = this.slackId(chatId);
    await this.app.client.files.uploadV2({
      channel_id: channel,
      file: buffer,
      filename,
      initial_comment: opts?.caption,
    });
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    const name = SlackChannel.EMOJI_TO_SLACK[emoji];
    if (!name) {
      log.warn("[channel] no Slack emoji name for %s, skipping reaction", emoji);
      return;
    }
    try {
      await this.app.client.reactions.add({
        channel: this.slackId(chatId),
        timestamp: messageId,
        name,
      });
    } catch (err) {
      log.warn("[channel] failed to add reaction %s: %s", name,
        err instanceof Error ? err.message : String(err));
    }
  }

  private slackId(chatId: string): string {
    return chatId.replace(/^slack:/, "");
  }

  /** Download a file from Slack using bot token auth. */
  private async downloadFile(url: string): Promise<Buffer> {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    if (!resp.ok) throw new Error(`Slack file download failed: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;
    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch { return undefined; }
  }

  /** Fetch the parent message of a thread reply for reply context. */
  private async fetchReplyContext(channel: string, threadTs: string, ownTs: string): Promise<ReplyContext | undefined> {
    if (threadTs === ownTs) return undefined;
    try {
      const result = await this.app.client.conversations.history({
        channel,
        latest: threadTs,
        limit: 1,
        inclusive: true,
      });
      const parent = result.messages?.[0] as MessageElement | undefined;
      if (!parent) return undefined;

      const senderName = parent.user ? await this.resolveUserName(parent.user) : undefined;

      return {
        messageId: threadTs,
        senderName: senderName ?? parent.user,
        text: parent.text,
        mediaType: parent.files?.[0]?.mimetype,
      };
    } catch (err) {
      log.warn({ err }, "[channel] failed to fetch thread parent %s", threadTs);
      return undefined;
    }
  }
}

function mrkdwnBlocks(text: string): KnownBlock[] {
  let rendered: string;
  try {
    rendered = slackifyMarkdown(text);
  } catch (err) {
    log.warn({ err }, "[channel] slackifyMarkdown failed, sending raw text");
    rendered = text;
  }
  return [{ type: "section", text: { type: "mrkdwn", text: rendered } }];
}

// Block Kit section.text has a 3000 char limit — the tightest Slack constraint.
// We split at this limit so each chunk fits both the text fallback and the block.
const MAX_TEXT = 3000;

function splitMessage(text: string): string[] {
  if (text.length <= MAX_TEXT) return [text];
  log.warn("[channel] splitting message (%d chars) into chunks", text.length);
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_TEXT) {
    const newlineAt = remaining.lastIndexOf("\n", MAX_TEXT);
    if (newlineAt > 0) {
      chunks.push(remaining.slice(0, newlineAt));
      remaining = remaining.slice(newlineAt + 1);
    } else {
      chunks.push(remaining.slice(0, MAX_TEXT));
      remaining = remaining.slice(MAX_TEXT);
    }
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
