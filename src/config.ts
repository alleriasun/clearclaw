import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PermissionMode } from "./types.js";

export interface Config {
  botToken: string;
  allowedChatId: number;
  defaultCwd: string;
  permissionMode: PermissionMode;
}

const DATA_DIR = path.join(os.homedir(), ".clearclaw");

export function loadConfig(): Config {
  const botToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const allowedChatId = Number(requireEnv("ALLOWED_CHAT_ID"));
  if (Number.isNaN(allowedChatId)) {
    throw new Error("ALLOWED_CHAT_ID must be a number");
  }

  const defaultCwd = process.env.DEFAULT_CWD ?? os.homedir();

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

  return { botToken, allowedChatId, defaultCwd, permissionMode };
}

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function dbPath(): string {
  return path.join(DATA_DIR, "clearclaw.db");
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}
