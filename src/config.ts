import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PermissionMode } from "./types.js";

export interface Config {
  botToken: string;
  allowedUserIds: Set<string>;
  permissionMode: PermissionMode;
  dataDir: string;
  defaultPromptPath: string;
  workspacesPath: string;
  logPath: string;
}

export function loadConfig(): Config {
  const dataDir =
    process.env.CLEARCLAW_HOME ?? path.join(os.homedir(), ".clearclaw");
  fs.mkdirSync(dataDir, { recursive: true });

  const botToken = requireEnv("TELEGRAM_BOT_TOKEN");

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
    botToken,
    allowedUserIds,
    permissionMode,
    dataDir,
    defaultPromptPath: path.join(dataDir, "workspace", "CLAUDE.md"),
    workspacesPath: path.join(dataDir, "workspaces.json"),
    logPath: path.join(dataDir, "clearclaw.log"),
  };
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}
