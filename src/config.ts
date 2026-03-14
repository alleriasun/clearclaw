import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PermissionMode } from "./types.js";

export interface TelegramConfig {
  type: "telegram";
  botToken: string;
}

export interface SlackConfig {
  type: "slack";
  botToken: string;
  appToken: string;
}

export type ChannelConfig = TelegramConfig | SlackConfig;

export interface Config {
  channel: ChannelConfig;
  allowedUserIds: Set<string>;
  permissionMode: PermissionMode;
  defaultPromptPath: string;
  workspaceStorePath: string;
  filesPath: string;
  logPath: string;
}

export function loadConfig(): Config {
  const dataDir =
    process.env.CLEARCLAW_HOME ?? path.join(os.homedir(), ".clearclaw");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "files"), { recursive: true });

  // Channel config: Slack takes priority if both SLACK_BOT_TOKEN and SLACK_APP_TOKEN are set
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackAppToken = process.env.SLACK_APP_TOKEN;
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;

  let channel: ChannelConfig;
  if (slackBotToken && slackAppToken) {
    channel = { type: "slack", botToken: slackBotToken, appToken: slackAppToken };
  } else if (telegramBotToken) {
    channel = { type: "telegram", botToken: telegramBotToken };
  } else {
    throw new Error("Missing channel config: set TELEGRAM_BOT_TOKEN or both SLACK_BOT_TOKEN + SLACK_APP_TOKEN");
  }

  const rawIds = process.env.ALLOWED_USER_IDS ?? process.env.ALLOWED_USER_ID;
  if (!rawIds) throw new Error("Missing required env var: ALLOWED_USER_IDS");
  const allowedUserIds = new Set(
    rawIds.split(",").map((s) => s.trim()).filter(Boolean),
  );

  const permissionMode = (process.env.PERMISSION_MODE ?? "default") as PermissionMode;
  const valid = [
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "dontAsk",
  ] as const satisfies readonly PermissionMode[];
  if (!(valid as readonly string[]).includes(permissionMode)) {
    throw new Error(
      `PERMISSION_MODE must be one of: ${valid.join(", ")}`,
    );
  }

  return {
    channel,
    allowedUserIds,
    permissionMode,
    defaultPromptPath: path.join(dataDir, "workspace", "CLAUDE.md"),
    workspaceStorePath: path.join(dataDir, "workspaces.json"),
    filesPath: path.join(dataDir, "files"),
    logPath: path.join(dataDir, "clearclaw.log"),
  };
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}
