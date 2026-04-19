#!/usr/bin/env node

import readline from "node:readline";
import { Config } from "./config.js";
import type { ChannelConfig } from "./config.js";
import log, { initLogger } from "./logger.js";
import { ClaudeCodeEngine } from "./engine/claude-code.js";
import { TelegramChannel } from "./channel/telegram.js";
import { SlackChannel } from "./channel/slack.js";
import { Orchestrator } from "./orchestrator.js";
import type { Channel, UserInfo } from "./types.js";

async function runDaemon(): Promise<void> {
  const config = new Config().resolve();
  initLogger(config.logPath);

  // The Claude Agent SDK has a bug: handleControlRequest() writes to the
  // subprocess stdin without a .catch(), so aborting during a permission
  // callback causes an unhandled rejection (write to dead process).
  // Suppress that specific error so we can use abort for deny + /cancel.
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (
      msg.includes("Operation aborted") ||
      msg.includes("Failed to write to process stdin") ||
      msg.includes("Cannot write to terminated process")
    ) {
      log.warn("[sdk] suppressed write error (known SDK bug): %s", msg);
      return;
    }
    log.fatal({ err: reason }, "Unhandled rejection");
    process.exit(1);
  });

  // Daemon always uses pairing code flow (no console/readline)
  const onUnauthorizedDM = (chatId: string, user: UserInfo): void => {
    const code = config.createPairing(user.id, user.name, chatId);
    const text = [
      `Your user ID: ${user.id}`,
      `Pairing code: ${code}`,
      "",
      "Ask the server owner to run:",
      `  clearclaw approve ${code}`,
      "",
      "Code expires in 1 hour.",
    ].join("\n");
    channel.sendMessage(chatId, text).catch((err) => {
      log.warn({ err }, "[pairing] failed to send pairing message");
    });
  };

  const channel = createChannel(config.channel!, (userId) => config.isAuthorized(userId), onUnauthorizedDM);

  await new Orchestrator({ channel, engine: new ClaudeCodeEngine(), config }).start();
}

async function runApprove(args: string[]): Promise<void> {
  const code = args[0];
  if (!code) {
    console.error("Usage: clearclaw approve <code>");
    process.exit(1);
  }

  const config = new Config();

  const pairing = config.consumePairing(code);
  if (!pairing) {
    console.error("Invalid or expired pairing code.");
    process.exit(1);
  }

  config.approveUser(pairing.userId, pairing.userName);
  console.log(`Approved ${pairing.userName} (${pairing.userId})`);
}

const SETUP_TIMEOUT_MS = 5 * 60 * 1000;

async function runSetup(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));
  let channel: Channel | null = null;
  try {
    console.log("ClearClaw setup\n");

    let channelType: string;
    while (true) {
      channelType = (await ask("Channel [telegram/slack]: ")).trim().toLowerCase();
      if (channelType === "telegram" || channelType === "slack") break;
      console.log('  Please enter "telegram" or "slack".');
    }

    let channelConfig: ChannelConfig;
    if (channelType === "slack") {
      const botToken = (await ask("Slack bot token (xoxb-...): ")).trim();
      const appToken = (await ask("Slack app token (xapp-...): ")).trim();
      if (!botToken || !appToken) throw new Error("Both tokens required for Slack.");
      channelConfig = { type: "slack", botToken, appToken };
    } else {
      const botToken = (await ask("Telegram bot token: ")).trim();
      if (!botToken) throw new Error("Bot token required.");
      channelConfig = { type: "telegram", botToken };
    }

    const config = new Config();
    config.setChannel(channelConfig);
    console.log("Saved to ~/.clearclaw/config.json\n");
    config.resolve();

    let resolveFirstDM!: (info: { chatId: string; user: UserInfo }) => void;
    const firstDM = new Promise<{ chatId: string; user: UserInfo }>((r) => {
      resolveFirstDM = r;
    });

    channel = createChannel(
      config.channel!,
      (userId) => config.isAuthorized(userId),
      (chatId, user) => resolveFirstDM({ chatId, user }),
    );

    console.log("Connecting...");
    await channel.connect();
    console.log("Connected! Waiting for a DM — message the bot from your chat app.\n");

    const { chatId, user } = await Promise.race([
      firstDM,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Timed out. Run `clearclaw setup` again.")),
          SETUP_TIMEOUT_MS,
        ),
      ),
    ]);

    console.log(`→ Message from ${user.name} (${user.id})`);
    const pairingCode = config.createPairing(user.id, user.name, chatId);
    await channel.sendMessage(chatId, [
      `Pairing code: ${pairingCode}`,
      "",
      "The server owner is approving you now.",
      "Code expires in 1 hour.",
    ].join("\n"));

    const entered = (await ask("  Enter pairing code to approve: ")).trim();
    const pairing = config.consumePairing(entered);
    if (!pairing) {
      console.log("  Invalid code. Exiting.");
      await channel.sendMessage(chatId, "Pairing code was invalid. Please try again.");
      return;
    }

    config.approveUser(pairing.userId, pairing.userName);
    console.log(`  Approved ${pairing.userName} (${pairing.userId})`);
    await channel.sendMessage(chatId, "You're approved! The bot is being set up — you'll be able to chat soon.");
    console.log("\nSetup complete! Start the daemon:\n  clearclaw daemon\n");
  } finally {
    if (channel) await channel.disconnect().catch(() => {});
    rl.close();
  }
}

function createChannel(
  ch: ChannelConfig,
  isAuthorized: (userId: string) => boolean,
  onUnauthorizedDM: (chatId: string, user: UserInfo) => void,
): Channel {
  if (ch.type === "slack") {
    return new SlackChannel(ch.botToken, ch.appToken, isAuthorized, onUnauthorizedDM);
  }
  return new TelegramChannel(ch.botToken, isAuthorized, onUnauthorizedDM);
}


switch (process.argv[2]) {
  case "setup":   await runSetup(); break;
  case "approve": await runApprove(process.argv.slice(3)); break;
  case "daemon":  await runDaemon(); break;
  default:
    console.log(`Usage: clearclaw <command>\n\nCommands:\n  setup     Interactive first-run setup\n  daemon    Start the relay daemon\n  approve   Approve a pairing code\n\nRun 'clearclaw setup' to get started.`);
    process.exit(process.argv[2] ? 1 : 0);
}


