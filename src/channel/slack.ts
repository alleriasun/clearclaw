import { EventEmitter } from "node:events";
import { App, LogLevel } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import log from "../logger.js";
import type { Attachment, Channel, Button, ButtonResponse, SendMessageOpts } from "../types.js";

export class SlackChannel extends EventEmitter implements Channel {
  name = "slack";

  private app: App;
  private botToken: string;
  private botUserId: string | undefined;
  private allowedUserIds: Set<string>;
  private pendingButtonCallbacks = new Map<string, () => void>(); // actionId → resolve
  private pendingTextCallbacks = new Map<string, (text: string) => void>(); // chatId → resolve
  private typingAnchorTs = new Map<string, string>(); // chatId → ts of last user message (for 👀 reaction)
  private userNameCache = new Map<string, string>();

  constructor(botToken: string, appToken: string, allowedUserIds: Set<string>) {
    super();
    this.botToken = botToken;
    this.allowedUserIds = allowedUserIds;
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
        text?: string; ts: string;
        files?: Array<{ url_private_download?: string; mimetype?: string; name?: string }>;
      };

      const chatId = `slack:${msg.channel}`;
      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;
      if (isBotMessage) return;

      // Need either text or files to proceed
      if (!msg.text && (!msg.files || msg.files.length === 0)) return;

      const userId = msg.user;
      if (!userId || !this.allowedUserIds.has(`slack:${userId}`)) {
        if (userId) log.info("[channel] ignored message from unauthorized user slack:%s", userId);
        return;
      }

      this.typingAnchorTs.set(chatId, msg.ts);

      // Intercept for requestText follow-ups
      const textResolver = this.pendingTextCallbacks.get(chatId);
      if (textResolver) {
        this.pendingTextCallbacks.delete(chatId);
        textResolver(msg.text ?? "");
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

      const userName = await this.resolveUserName(userId);
      this.emit("message", {
        chatId,
        user: { id: `slack:${userId}`, name: userName ?? userId },
        text: msg.text ?? "",
        ...(attachments && { attachments }),
      });
    });

    // Handle button presses from sendInteractive
    this.app.action(/^ccb:/, async ({ action, ack }) => {
      await ack();
      const actionId = (action as { action_id: string }).action_id;
      const resolve = this.pendingButtonCallbacks.get(actionId);
      if (resolve) resolve();
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
    // Remove lingering typing reactions
    for (const [chatId, ts] of this.typingAnchorTs) {
      try {
        await this.app.client.reactions.remove({
          channel: this.slackId(chatId), timestamp: ts, name: "eyes",
        });
      } catch { /* already removed or no permission */ }
    }
    this.typingAnchorTs.clear();
    await this.app.stop();
  }
  ownsId(chatId: string): boolean { return chatId.startsWith("slack:"); }
  async sendMessage(
    chatId: string,
    text: string,
    _opts?: SendMessageOpts,
  ): Promise<string[]> {
    const channel = this.slackId(chatId);
    const chunks = splitMessage(text);
    const handles: string[] = [];
    for (const chunk of chunks) {
      const blocks: KnownBlock[] = [
        { type: "section", text: { type: "mrkdwn", text: chunk } },
      ];
      const result = await this.app.client.chat.postMessage({
        channel, text: chunk, blocks,
      });
      if (result.ts) handles.push(result.ts as string);
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
      { type: "section", text: { type: "mrkdwn", text: splitMessage(text)[0] } },
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
    const pressed = await new Promise<Button>((resolve) => {
      for (const entry of actionEntries) {
        this.pendingButtonCallbacks.set(entry.actionId, () => {
          cleanupAll();
          resolve(entry.btn);
        });
      }
    });

    if (pressed.requestText) {
      await this.app.client.chat.postMessage({
        channel,
        text: "Add your feedback:",
        ...(result.ts && { thread_ts: result.ts as string }),
      });
      const followUpText = await new Promise<string>((resolve) => {
        this.pendingTextCallbacks.set(chatId, resolve);
      });
      return { value: pressed.value, text: followUpText };
    }

    return { value: pressed.value };
  }

  async editMessage(chatId: string, handle: string, text: string): Promise<void> {
    const chunk = splitMessage(text)[0];
    await this.app.client.chat.update({
      channel: this.slackId(chatId),
      ts: handle,
      text: chunk,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: chunk } }],
    });
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

  async setTyping(chatId: string, isTyping: boolean): Promise<void> {
    const channel = this.slackId(chatId);
    const ts = this.typingAnchorTs.get(chatId);
    if (!ts) return;

    try {
      if (isTyping) {
        await this.app.client.reactions.add({ channel, timestamp: ts, name: "eyes" });
      } else {
        await this.app.client.reactions.remove({ channel, timestamp: ts, name: "eyes" });
      }
    } catch { /* already added/removed, or no permission */ }
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
