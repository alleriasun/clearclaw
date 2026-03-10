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
  private allowedUserIds: Set<string>;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  // Pending interactive responses: callbackId → resolve function
  private pendingCallbacks = new Map<
    string,
    (value: string) => void
  >();

  // Pending text input: chatId → resolve function (for requestText follow-ups)
  private pendingTextResolvers = new Map<string, (text: string) => void>();

  constructor(botToken: string, allowedUserIds: Set<string>) {
    super();
    this.allowedUserIds = allowedUserIds;
    this.bot = new Bot(botToken);
  }

  async connect(): Promise<void> {
    // Auth check: only respond to allowed user
    this.bot.on("message:text", (ctx) => {
      if (!ctx.from?.id || !this.allowedUserIds.has(`tg:${ctx.from.id}`)) return;
      const chatId = `tg:${ctx.chat.id}`;

      // Intercept for requestText follow-ups before emitting as a new message
      const textResolver = this.pendingTextResolvers.get(chatId);
      if (textResolver) {
        this.pendingTextResolvers.delete(chatId);
        textResolver(ctx.message.text);
        return;
      }

      const user = {
        id: `tg:${ctx.from.id}`,
        name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" "),
        ...(ctx.from.username && { handle: ctx.from.username }),
      };

      this.emit("message", { chatId, user, text: ctx.message.text });
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

  ownsId(chatId: string): boolean {
    return chatId.startsWith("tg:");
  }

  async sendMessage(
    chatId: string,
    text: string,
    opts?: SendMessageOpts,
  ): Promise<void> {
    const numId = this.numericId(chatId);
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(numId, chunk, {
          parse_mode: opts?.parseMode,
        });
      } catch (err) {
        if (opts?.parseMode) {
          log.warn("[channel] sendMessage failed with %s, retrying as plain text", opts.parseMode);
          await this.bot.api.sendMessage(numId, chunk);
        } else {
          throw err;
        }
      }
    }
  }

  async sendInteractive(
    chatId: string,
    text: string,
    buttons: Button[],
  ): Promise<ButtonResponse> {
    const numId = this.numericId(chatId);
    const callbackId = crypto.randomUUID().slice(0, 8);

    // Pre-compute callback data keys (use index to avoid collisions when buttons share values)
    const cbEntries = buttons.map((btn, i) => ({
      btn,
      cbData: `${callbackId}:${i}`,
    }));

    // Build inline keyboard
    const keyboard = new InlineKeyboard();
    for (const { btn, cbData } of cbEntries) {
      keyboard.text(btn.label, cbData);
    }

    await this.bot.api.sendMessage(numId, text, {
      reply_markup: keyboard,
    });

    const cleanupAll = () => {
      for (const { cbData } of cbEntries) {
        this.pendingCallbacks.delete(cbData);
      }
    };

    // Wait for button press or timeout (30 minutes)
    const pressed = await new Promise<Button | null>((resolve) => {
      const timeout = setTimeout(() => {
        cleanupAll();
        resolve(null);
      }, 30 * 60 * 1000);

      for (const { btn, cbData } of cbEntries) {
        this.pendingCallbacks.set(cbData, () => {
          clearTimeout(timeout);
          cleanupAll();
          resolve(btn);
        });
      }
    });

    if (!pressed) return { value: "" };

    // If the button requests text, prompt for follow-up input
    if (pressed.requestText) {
      await this.bot.api.sendMessage(numId, "Type your note:", {
        reply_markup: { force_reply: true },
      });
      const followUpText = await new Promise<string>((resolve) => {
        this.pendingTextResolvers.set(chatId, resolve);
      });
      return { value: pressed.value, text: followUpText };
    }

    return { value: pressed.value };
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

  private numericId(chatId: string): number {
    return Number(chatId.replace(/^tg:/, ""));
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
