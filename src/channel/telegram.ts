import { EventEmitter } from "node:events";
import { Bot, type Context, InlineKeyboard } from "grammy";
import log from "../logger.js";
import type {
  Attachment,
  Channel,
  Button,
  ButtonResponse,
  SendMessageOpts,
} from "../types.js";

export class TelegramChannel extends EventEmitter implements Channel {
  name = "telegram";

  private bot: Bot;
  private botToken: string;
  private allowedUserIds: Set<string>;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private statusHandles = new Map<string, string>(); // chatId → message handle for pinned status

  // Pending interactive responses: callbackId → resolve function
  private pendingCallbacks = new Map<
    string,
    (value: string) => void
  >();

  // Pending text input: chatId → resolve function (for requestText follow-ups)
  private pendingTextResolvers = new Map<string, (text: string) => void>();

  constructor(botToken: string, allowedUserIds: Set<string>) {
    super();
    this.botToken = botToken;
    this.allowedUserIds = allowedUserIds;
    this.bot = new Bot(botToken);
  }

  async connect(): Promise<void> {
    this.bot.on("message:text", (ctx) => {
      const sender = this.extractSender(ctx);
      if (!sender) return;

      // Intercept for requestText follow-ups before emitting as a new message
      const textResolver = this.pendingTextResolvers.get(sender.chatId);
      if (textResolver) {
        this.pendingTextResolvers.delete(sender.chatId);
        textResolver(ctx.message.text);
        return;
      }

      this.emit("message", { ...sender, text: ctx.message.text });
    });

    // Photos: Telegram sends each photo as an array of PhotoSize objects
    // (same image at different resolutions, sorted smallest → largest).
    // We grab the last element for the highest resolution version.
    this.bot.on("message:photo", async (ctx) => {
      const photo = ctx.message.photo;
      const largest = photo[photo.length - 1];
      await this.handleMediaMessage(ctx, largest.file_id, "image/jpeg", undefined, ctx.message.caption);
    });

    // Documents: download with original MIME + filename
    this.bot.on("message:document", async (ctx) => {
      const doc = ctx.message.document;
      await this.handleMediaMessage(
        ctx, doc.file_id,
        doc.mime_type ?? "application/octet-stream",
        doc.file_name,
        ctx.message.caption,
      );
    });

    // Placeholder handlers for unsupported media types
    for (const [filter, label] of [
      ["message:voice", "Voice message"],
      ["message:audio", "Audio message"],
      ["message:video", "Video"],
      ["message:sticker", "Sticker"],
    ] as const) {
      this.bot.on(filter, (ctx) => {
        const sender = this.extractSender(ctx);
        if (!sender) return;
        this.emit("message", { ...sender, text: `[${label} — not supported]` });
      });
    }

    // Handle inline keyboard button presses
    this.bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      const resolve = this.pendingCallbacks.get(data);
      if (resolve) {
        this.pendingCallbacks.delete(data);
        resolve(data);
      }
      await ctx.answerCallbackQuery();
    });

    this.bot.catch((err) => {
      log.error("[channel] Telegram bot error: %s", err.message);
    });

    await new Promise<void>((resolve) => {
      this.bot.start({
        onStart: (botInfo) => {
          log.info(`[channel] Telegram bot: @${botInfo.username}`);
          resolve();
        },
      });
    });
  }

  async disconnect(): Promise<void> {
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    this.statusHandles.clear();
    await this.bot.stop();
  }

  ownsId(chatId: string): boolean {
    return chatId.startsWith("tg:");
  }

  async sendMessage(
    chatId: string,
    text: string,
    opts?: SendMessageOpts,
  ): Promise<string[]> {
    const numId = this.numericId(chatId);
    const chunks = splitMessage(text);
    const handles: string[] = [];
    for (const chunk of chunks) {
      try {
        const sent = await this.bot.api.sendMessage(numId, chunk, {
          parse_mode: opts?.parseMode,
        });
        handles.push(String(sent.message_id));
      } catch (err) {
        if (opts?.parseMode) {
          log.warn("[channel] sendMessage failed with %s, retrying as plain text", opts.parseMode);
          const sent = await this.bot.api.sendMessage(numId, chunk);
          handles.push(String(sent.message_id));
        } else {
          throw err;
        }
      }
    }
    return handles;
  }

  async sendInteractive(
    chatId: string,
    text: string,
    buttons: Button[][],
  ): Promise<ButtonResponse> {
    const numId = this.numericId(chatId);
    const callbackId = crypto.randomUUID().slice(0, 8);

    // Pre-compute callback data keys (use flat index to avoid collisions when buttons share values)
    const cbEntries: { btn: Button; cbData: string }[] = [];
    let idx = 0;
    for (const row of buttons) {
      for (const btn of row) {
        cbEntries.push({ btn, cbData: `${callbackId}:${idx++}` });
      }
    }

    // Build inline keyboard — each inner array is a row
    const keyboard = new InlineKeyboard();
    let flatIdx = 0;
    for (const row of buttons) {
      for (const _btn of row) {
        const { cbData } = cbEntries[flatIdx++];
        keyboard.text(_btn.label, cbData);
      }
      keyboard.row();
    }

    // Convert universal markdown to MarkdownV2, fall back to plain text on failure
    const mdv2Text = convertToMarkdownV2(text);
    let sent;
    try {
      sent = await this.bot.api.sendMessage(numId, mdv2Text, {
        reply_markup: keyboard,
        parse_mode: "MarkdownV2",
      });
    } catch {
      log.warn("[channel] sendInteractive failed with MarkdownV2, retrying as plain text");
      sent = await this.bot.api.sendMessage(numId, text, {
        reply_markup: keyboard,
      });
    }

    const cleanupAll = () => {
      for (const { cbData } of cbEntries) {
        this.pendingCallbacks.delete(cbData);
      }
    };

    // Wait for button press (no timeout — matches CLI behavior)
    const pressed = await new Promise<Button>((resolve) => {
      for (const { btn, cbData } of cbEntries) {
        this.pendingCallbacks.set(cbData, () => {
          cleanupAll();
          resolve(btn);
        });
      }
    });

    // If the button requests text, prompt for follow-up input
    if (pressed.requestText) {
      await this.bot.api.sendMessage(numId, "Add your feedback:", {
        reply_markup: { force_reply: true },
        reply_parameters: { message_id: sent.message_id },
      });
      const followUpText = await new Promise<string>((resolve) => {
        this.pendingTextResolvers.set(chatId, resolve);
      });
      return { value: pressed.value, text: followUpText };
    }

    return { value: pressed.value };
  }

  async editMessage(chatId: string, handle: string, text: string): Promise<void> {
    const numId = this.numericId(chatId);
    await this.bot.api.editMessageText(numId, Number(handle), text);
  }

  async deleteMessage(chatId: string, handle: string): Promise<void> {
    const numId = this.numericId(chatId);
    await this.bot.api.deleteMessage(numId, Number(handle));
  }

  async pinMessage(chatId: string, handle: string): Promise<void> {
    const numId = this.numericId(chatId);
    await this.bot.api.pinChatMessage(numId, Number(handle), {
      disable_notification: true,
    });
  }

  async unpinAllMessages(chatId: string): Promise<void> {
    const numId = this.numericId(chatId);
    await this.bot.api.unpinAllChatMessages(numId);
  }

  async updateStatus(chatId: string, text: string): Promise<void> {
    const existing = this.statusHandles.get(chatId);
    if (existing) {
      try {
        await this.editMessage(chatId, existing, text);
        return;
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("message is not modified"))) {
          // Edit failed for a real reason — fall through to create new
          log.warn("[channel] failed to edit status message, will recreate: %s",
            err instanceof Error ? err.message : String(err));
          this.statusHandles.delete(chatId);
        } else {
          return; // text unchanged, nothing to do
        }
      }
    }
    // No existing handle, or edit failed — create new pinned message
    try { await this.unpinAllMessages(chatId); } catch { /* not admin */ }
    const handles = await this.sendMessage(chatId, text);
    const handle = handles[0];
    this.statusHandles.set(chatId, handle);
    try {
      await this.pinMessage(chatId, handle);
    } catch (err) {
      log.warn("[channel] failed to pin status message (bot may not be admin): %s",
        err instanceof Error ? err.message : String(err));
    }
  }

  async setTyping(
    chatId: string,
    isTyping: boolean,
  ): Promise<void> {
    if (isTyping) {
      if (this.typingIntervals.has(chatId)) return;
      const numId = this.numericId(chatId);
      // Send immediately, then repeat every 4s
      await this.bot.api
        .sendChatAction(numId, "typing")
        .catch(() => {});
      const interval = setInterval(() => {
        this.bot.api.sendChatAction(numId, "typing").catch(() => {});
      }, 4000);
      this.typingIntervals.set(chatId, interval);
    } else {
      const interval = this.typingIntervals.get(chatId);
      if (interval) {
        clearInterval(interval);
        this.typingIntervals.delete(chatId);
      }
    }
  }

  /** Extract auth-checked sender info from a grammY context. Returns null if unauthorized. */
  private extractSender(ctx: Context): { chatId: string; user: { id: string; name: string; handle?: string } } | null {
    if (!ctx.from?.id || !ctx.chat?.id || !this.allowedUserIds.has(`tg:${ctx.from.id}`)) return null;
    return {
      chatId: `tg:${ctx.chat.id}`,
      user: {
        id: `tg:${ctx.from.id}`,
        name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" "),
        ...(ctx.from.username && { handle: ctx.from.username }),
      },
    };
  }

  /** Shared handler for photo/document messages: download, emit attachment or fallback. */
  private async handleMediaMessage(
    ctx: Context,
    fileId: string,
    mimeType: string,
    filename?: string,
    caption?: string,
  ): Promise<void> {
    const sender = this.extractSender(ctx);
    if (!sender) return;
    try {
      const buffer = await this.downloadFile(fileId);
      this.emit("message", {
        ...sender,
        text: caption ?? "",
        attachments: [{ buffer, mimeType, filename }],
      });
    } catch (err) {
      log.warn({ err }, "[channel] failed to download file %s", filename ?? fileId);
      this.emit("message", {
        ...sender,
        text: caption
          ? `${caption}\n[File download failed: ${filename ?? mimeType}]`
          : `[File download failed: ${filename ?? mimeType}]`,
      });
    }
  }

  /** Download a Telegram file by file_id, returning the raw buffer. */
  private async downloadFile(fileId: string): Promise<Buffer> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram returned no file_path");
    const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`File download failed: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  private numericId(chatId: string): number {
    return Number(chatId.replace(/^tg:/, ""));
  }
}

/**
 * Escape for Telegram MarkdownV2.
 * Outside code blocks: all special chars. Inside: only backtick and backslash.
 */
function escapeMarkdownV2(text: string, codeBlock = false): string {
  const pattern = codeBlock ? /[`\\]/g : /[_*\[\]()~`>#+\-=|{}.!\\]/g;
  return text.replace(pattern, "\\$&");
}

/**
 * Convert universal markdown (with code fences) to Telegram MarkdownV2.
 * Handles code blocks specially: fence markers stay literal, inner content
 * only escapes ` and \, outer text gets full MarkdownV2 escaping.
 */
function convertToMarkdownV2(markdown: string): string {
  const result: string[] = [];
  let pos = 0;
  const fenceRegex = /```(\w*)\n([\s\S]*?)```/g;
  let match;

  while ((match = fenceRegex.exec(markdown)) !== null) {
    if (match.index > pos) {
      result.push(escapeMarkdownV2(markdown.slice(pos, match.index)));
    }
    result.push("```" + match[1] + "\n");
    result.push(escapeMarkdownV2(match[2], true));
    result.push("```");
    pos = match.index + match[0].length;
  }

  if (pos < markdown.length) {
    result.push(escapeMarkdownV2(markdown.slice(pos)));
  }

  return result.join("");
}

const MAX_MSG_LEN = 4096;

/** Split text into ≤4096-char chunks, preferring newline boundaries. */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MSG_LEN) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_MSG_LEN) {
    // Find last newline within the limit
    const newlineAt = remaining.lastIndexOf("\n", MAX_MSG_LEN);
    if (newlineAt > 0) {
      chunks.push(remaining.slice(0, newlineAt));
      remaining = remaining.slice(newlineAt + 1); // skip the newline
    } else {
      // No newline found — hard split, no char skipped
      chunks.push(remaining.slice(0, MAX_MSG_LEN));
      remaining = remaining.slice(MAX_MSG_LEN);
    }
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
