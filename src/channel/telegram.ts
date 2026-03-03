import { Bot, InlineKeyboard } from "grammy";
import type {
  Channel,
  Button,
  ButtonResponse,
  InboundMessage,
} from "../types.js";

interface TelegramChannelOpts {
  onMessage: (msg: InboundMessage) => Promise<void>;
}

export class TelegramChannel implements Channel {
  name = "telegram";

  private bot: Bot;
  private allowedChatId: number;
  private opts: TelegramChannelOpts;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  // Pending interactive responses: callbackId → resolve function
  private pendingCallbacks = new Map<
    string,
    (value: string) => void
  >();

  constructor(
    botToken: string,
    allowedChatId: number,
    opts: TelegramChannelOpts,
  ) {
    this.allowedChatId = allowedChatId;
    this.opts = opts;
    this.bot = new Bot(botToken);
  }

  async connect(): Promise<void> {
    // Auth check: only respond to allowed chat
    this.bot.on("message:text", (ctx) => {
      if (ctx.chat.id !== this.allowedChatId) return;
      const channelId = `tg:${ctx.chat.id}`;
      // Fire-and-forget: must not await, otherwise grammY's sequential
      // update processing blocks callback_query and deadlocks permissions.
      this.opts.onMessage({
        channelId,
        text: ctx.message.text,
      }).catch((err) => {
        console.error("[channel] unhandled onMessage error:", err);
      });
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
      console.error("Telegram bot error:", err.message);
    });

    await new Promise<void>((resolve) => {
      this.bot.start({
        onStart: (botInfo) => {
          console.log(`Telegram bot: @${botInfo.username}`);
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

  async sendMessage(channelId: string, text: string): Promise<void> {
    const chatId = this.numericId(channelId);
    // Truncate at 4096 for now (splitting is backlog)
    const truncated =
      text.length > 4096 ? text.slice(0, 4093) + "..." : text;
    await this.bot.api.sendMessage(chatId, truncated);
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

    // Wait for button press or timeout (5 minutes)
    return new Promise<ButtonResponse>((resolve) => {
      const timeout = setTimeout(() => {
        cleanupAll();
        resolve({ value: "" });
      }, 5 * 60 * 1000);

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
