import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { PermissionMode, Workspace } from "./types.js";

// --- Channel config types ---

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

// --- Auth / pairing data types ---

export interface AuthorizedUser {
  id: string;        // platform-prefixed, e.g. "tg:12345"
  name: string;      // display name at time of approval
  approvedAt: number; // epoch ms
}

export interface PendingPairing {
  code: string;
  userId: string;     // platform-prefixed, e.g. "tg:12345"
  userName: string;
  chatId: string;     // platform-prefixed chat ID (for auto-creating workspace on approval)
  expiresAt: number;  // epoch ms
}

// --- Internal file structure ---

interface ConfigData {
  channel?: ChannelConfig;
  authorizedUsers: AuthorizedUser[];
  pendingPairings: PendingPairing[];
  workspaces: Workspace[];
}

// --- Pairing constants ---

const CODE_LENGTH = 8;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no ambiguous 0/O/1/I/l
const EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const MAX_PENDING = 3;

// --- Resolve data directory ---

export function resolveDataDir(): string {
  const dataDir =
    process.env.CLEARCLAW_HOME ?? path.join(os.homedir(), ".clearclaw");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "files"), { recursive: true });
  return dataDir;
}

// --- Config class ---

/**
 * Unified config: env var resolution + persistent store backed by config.json.
 *
 * - `new Config(dataDir)` gives store access (read/write methods)
 * - `config.resolve()` adds env var settings (channel, envUserIds, permissionMode)
 *
 * File is re-read on every store call (hot-reload without file watching).
 * Writes use 0o600 permissions (file contains bot token).
 */
export class Config {
  // Resolved settings — populated by resolve()
  channel?: ChannelConfig;
  permissionMode: PermissionMode = "default";
  private envUserIds = new Set<string>();

  // Derived paths
  readonly defaultPromptPath: string;
  readonly filesPath: string;
  readonly logPath: string;

  private readonly dataDir = resolveDataDir();
  private readonly filePath: string;

  constructor() {
    this.filePath = path.join(this.dataDir, "config.json");
    this.defaultPromptPath = path.join(this.dataDir, "workspace", "CLAUDE.md");
    this.filesPath = path.join(this.dataDir, "files");
    this.logPath = path.join(this.dataDir, "clearclaw.log");
  }

  /** Resolve channel + env vars. Throws if no channel config found. */
  resolve(): this {
    const slackBotToken = process.env.SLACK_BOT_TOKEN;
    const slackAppToken = process.env.SLACK_APP_TOKEN;
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;

    if (slackBotToken && slackAppToken) {
      this.channel = { type: "slack", botToken: slackBotToken, appToken: slackAppToken };
    } else if (telegramBotToken) {
      this.channel = { type: "telegram", botToken: telegramBotToken };
    } else {
      const saved = this.getChannel();
      if (!saved) {
        throw new Error(
          "Missing channel config: set TELEGRAM_BOT_TOKEN or SLACK_BOT_TOKEN + SLACK_APP_TOKEN, or run `clearclaw setup`",
        );
      }
      this.channel = saved;
    }

    const rawIds = process.env.ALLOWED_USER_IDS ?? process.env.ALLOWED_USER_ID;
    this.envUserIds = new Set(
      rawIds ? rawIds.split(",").map((s) => s.trim()).filter(Boolean) : [],
    );

    const pm = (process.env.PERMISSION_MODE ?? "default") as PermissionMode;
    const valid = [
      "default", "acceptEdits", "bypassPermissions", "plan", "dontAsk",
    ] as const satisfies readonly PermissionMode[];
    if (!(valid as readonly string[]).includes(pm)) {
      throw new Error(`PERMISSION_MODE must be one of: ${valid.join(", ")}`);
    }
    this.permissionMode = pm;

    return this;
  }

  // --- File I/O (internal) ---

  private read(): ConfigData {
    if (!fs.existsSync(this.filePath)) {
      return { authorizedUsers: [], pendingPairings: [], workspaces: [] };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      return {
        channel: raw.channel,
        authorizedUsers: raw.authorizedUsers ?? [],
        pendingPairings: raw.pendingPairings ?? [],
        workspaces: raw.workspaces ?? [],
      };
    } catch {
      return { authorizedUsers: [], pendingPairings: [], workspaces: [] };
    }
  }

  private write(data: ConfigData): void {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  }

  // --- Channel ---

  getChannel(): ChannelConfig | undefined {
    return this.read().channel;
  }

  setChannel(config: ChannelConfig): void {
    const data = this.read();
    data.channel = config;
    this.write(data);
  }

  // --- Authorized users ---

  hasUser(userId: string): boolean {
    return this.read().authorizedUsers.some((u) => u.id === userId);
  }

  addUser(user: AuthorizedUser): void {
    const data = this.read();
    if (data.authorizedUsers.some((u) => u.id === user.id)) return;
    data.authorizedUsers.push(user);
    this.write(data);
  }

  listUsers(): AuthorizedUser[] {
    return this.read().authorizedUsers;
  }

  /** env var IDs (in-memory) + pairing-approved users (hot-reload from disk) */
  isAuthorized(userId: string): boolean {
    return this.envUserIds.has(userId) || this.hasUser(userId);
  }

  // --- Pairing codes ---

  createPairing(userId: string, userName: string, chatId: string): string {
    const data = this.read();
    const now = Date.now();

    // Filter expired
    data.pendingPairings = data.pendingPairings.filter((p) => p.expiresAt > now);

    // Idempotent: return existing code for same user
    const existing = data.pendingPairings.find((p) => p.userId === userId);
    if (existing) {
      this.write(data);
      return existing.code;
    }

    // Evict oldest if at capacity
    if (data.pendingPairings.length >= MAX_PENDING) {
      data.pendingPairings.sort((a, b) => a.expiresAt - b.expiresAt);
      data.pendingPairings = data.pendingPairings.slice(data.pendingPairings.length - MAX_PENDING + 1);
    }

    const code = this.generateCode();
    data.pendingPairings.push({ code, userId, userName, chatId, expiresAt: now + EXPIRY_MS });
    this.write(data);
    return code;
  }

  consumePairing(code: string): PendingPairing | null {
    const data = this.read();
    const now = Date.now();
    const idx = data.pendingPairings.findIndex(
      (p) => p.code.toLowerCase() === code.toLowerCase() && p.expiresAt > now,
    );
    if (idx < 0) return null;
    const [pairing] = data.pendingPairings.splice(idx, 1);
    this.write(data);
    return pairing;
  }

  private generateCode(): string {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    return Array.from(bytes)
      .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]!)
      .join("");
  }

  // --- Workspaces ---

  workspaceByChat(chatId: string): Workspace | undefined {
    return this.read().workspaces.find((ws) => ws.chat_id === chatId);
  }

  workspaceByName(name: string): Workspace | undefined {
    return this.read().workspaces.find((ws) => ws.name === name);
  }

  upsertWorkspace(ws: Workspace): void {
    const data = this.read();
    const idx = data.workspaces.findIndex((w) => w.name === ws.name);
    if (idx >= 0) data.workspaces[idx] = ws;
    else data.workspaces.push(ws);
    this.write(data);
  }

  setSession(name: string, sessionId: string): void {
    const data = this.read();
    const ws = data.workspaces.find((w) => w.name === name);
    if (ws) {
      ws.current_session_id = sessionId;
      this.write(data);
    }
  }

  clearSession(name: string): void {
    const data = this.read();
    const ws = data.workspaces.find((w) => w.name === name);
    if (ws) {
      ws.current_session_id = null;
      this.write(data);
    }
  }

  setBehavior(name: string, behavior: "assistant" | "relay"): void {
    const data = this.read();
    const ws = data.workspaces.find((w) => w.name === name);
    if (ws) {
      ws.behavior = behavior;
      this.write(data);
    }
  }

  // --- Approval ---

  ensureDefaultWorkspace(chatId: string): void {
    if (this.workspaceByChat(chatId) || this.workspaceByName("default")) return;
    const defaultCwd = path.join(this.dataDir, "workspace");
    fs.mkdirSync(defaultCwd, { recursive: true });
    this.upsertWorkspace({ name: "default", cwd: defaultCwd, chat_id: chatId, current_session_id: null });
  }

  approveUser(userId: string, userName: string, chatId: string): void {
    this.addUser({ id: userId, name: userName, approvedAt: Date.now() });
    this.ensureDefaultWorkspace(chatId);
  }
}
