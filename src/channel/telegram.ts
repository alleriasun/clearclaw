import { EventEmitter } from "node:events";
import { Bot, InlineKeyboard } from "grammy";
import log from "../logger.js";
import type {
  Channel,
  Button,
  ButtonResponse,
  SendMessageOpts,
} from "../types.js";

export class TelegramChannel extends EventEmitter implements Channel {
  name = "telegram";

  private bot: Bot;
  private allowedChatId: number;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  // Pending interactive responses: callbackId → resolve function
  private pendingCallbacks = new Map<
    string,
    (value: string) => void
  >();

  constructor(botToken: string, allowedChatId: number) {
    super();
    this.allowedChatId = allowedChatId;
    this.bot = new Bot(botToken);
  }

  async connect(): Promise<void> {
    // Auth check: only respond to allowed chat
    this.bot.on("message:text", (ctx) => {
      if (ctx.chat.id !== this.allowedChatId) return;
      const channelId = `tg:${ctx.chat.id}`;
      this.emit("message", { channelId, text: ctx.message.text });
    });

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
    await this.bot.stop();
  }

  ownsId(channelId: string): boolean {
    return channelId.startsWith("tg:");
  }

  async sendMessage(
    channelId: string,
    text: string,
    opts?: SendMessageOpts,
  ): Promise<void> {
    const chatId = this.numericId(channelId);
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(chatId, chunk, {
          parse_mode: opts?.parseMode,
        });
      } catch (err) {
        if (opts?.parseMode) {
          log.warn("[channel] sendMessage failed with %s, retrying as plain text", opts.parseMode);
          await this.bot.api.sendMessage(chatId, chunk);
        } else {
          throw err;
        }
      }
    }
  }

  async sendInteractive(
    channelId: string,
    text: string,
    buttons: Button[],
  ): Promise<ButtonResponse> {
    const chatId = this.numericId(channelId);
    const callbackId = crypto.randomUUID().slice(0, 8);

    // Pre-compute callback data keys
    const cbEntries = buttons.map((btn) => ({
      btn,
      cbData: `${callbackId}:${btn.value}`,
    }));

    // Build inline keyboard
    const keyboard = new InlineKeyboard();
    for (const { btn, cbData } of cbEntries) {
      keyboard.text(btn.label, cbData);
    }

    await this.bot.api.sendMessage(chatId, text, {
      reply_markup: keyboard,
    });

    const cleanupAll = () => {
      for (const { cbData } of cbEntries) {
        this.pendingCallbacks.delete(cbData);
      }
    };

    // Wait for button press or timeout (30 minutes)
    return new Promise<ButtonResponse>((resolve) => {
      const timeout = setTimeout(() => {
        cleanupAll();
        resolve({ value: "" });
      }, 30 * 60 * 1000);

      for (const { btn, cbData } of cbEntries) {
        this.pendingCallbacks.set(cbData, () => {
          clearTimeout(timeout);
          cleanupAll();
          resolve({ value: btn.value });
        });
      }
    });
  }

  async setTyping(
    channelId: string,
    isTyping: boolean,
  ): Promise<void> {
    if (isTyping) {
      if (this.typingIntervals.has(channelId)) return;
      const chatId = this.numericId(channelId);
      // Send immediately, then repeat every 4s
      await this.bot.api
        .sendChatAction(chatId, "typing")
        .catch(() => {});
      const interval = setInterval(() => {
        this.bot.api.sendChatAction(chatId, "typing").catch(() => {});
      }, 4000);
      this.typingIntervals.set(channelId, interval);
    } else {
      const interval = this.typingIntervals.get(channelId);
      if (interval) {
        clearInterval(interval);
        this.typingIntervals.delete(channelId);
      }
    }
  }

  private numericId(channelId: string): number {
    return Number(channelId.replace(/^tg:/, ""));
  }
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
