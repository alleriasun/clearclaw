import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PermissionMode } from "./types.js";

export interface Config {
  botToken: string;
  allowedUserId: number;
  permissionMode: PermissionMode;
}

const DATA_DIR = process.env.CLEARCLAW_HOME ?? path.join(os.homedir(), ".clearclaw");

export function loadConfig(): Config {
  const botToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const allowedUserId = Number(requireEnv("ALLOWED_USER_ID"));
  if (Number.isNaN(allowedUserId)) {
    throw new Error("ALLOWED_USER_ID must be a number");
  }

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

  return { botToken, allowedUserId, permissionMode };
}

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function dbPath(): string {
  return path.join(DATA_DIR, "clearclaw.db");
}

export function logPath(): string {
  return path.join(DATA_DIR, "clearclaw.log");
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}
