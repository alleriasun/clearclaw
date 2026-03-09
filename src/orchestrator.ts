import fs from "node:fs";
import path from "node:path";
import log from "./logger.js";
import { formatToolUse, formatToolResult } from "./format.js";
import type { WorkspaceStore } from "./workspace-store.js";
import type {
  Channel,
  Engine,
  EngineEvent,
  InboundMessage,
  PermissionMode,
} from "./types.js";

export interface OrchestratorOpts {
  channel: Channel;
  engine: Engine;
  workspaceStore: WorkspaceStore;
  permissionMode: PermissionMode;
  defaultPromptPath: string;
}

export class Orchestrator {
  private channel: Channel;
  private engine: Engine;
  private workspaceStore: WorkspaceStore;
  private permissionMode: PermissionMode;
  private defaultPromptPath: string;
  private busyChats = new Set<string>();

  constructor(opts: OrchestratorOpts) {
    this.channel = opts.channel;
    this.engine = opts.engine;
    this.workspaceStore = opts.workspaceStore;
    this.permissionMode = opts.permissionMode;
    this.defaultPromptPath = opts.defaultPromptPath;
  }

  async start(): Promise<void> {
    this.channel.on("message", (msg) => {
      this.handleMessage(msg).catch((err) => {
        log.error({ err }, "[orchestrator] unhandled message error");
      });
    });

    await this.channel.connect();
    log.info("ClearClaw ready.");

    const shutdown = async () => {
      await this.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  async stop(): Promise<void> {
    await this.channel.disconnect();
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    try {
      log.info(`[msg] ${msg.text.slice(0, 80)}`);

      // /new — reset session
      if (msg.text === "/new") {
        const ws = this.workspaceStore.byChat(msg.chatId);
        if (!ws) {
          await this.channel.sendMessage(msg.chatId, "No workspace linked to this group.");
          return;
        }
        this.workspaceStore.clearSession(ws.name);
        log.info("[cmd] session cleared for workspace %s", ws.name);
        await this.channel.sendMessage(msg.chatId, "Session cleared.");
        return;
      }

      // Reject during active turn (per-workspace)
      if (this.busyChats.has(msg.chatId)) {
        log.info("[msg] rejected (busy)");
        await this.channel.sendMessage(
          msg.chatId,
          "Still working on the previous message...",
        );
        return;
      }

      this.busyChats.add(msg.chatId);
      const ws = this.workspaceStore.byChat(msg.chatId);
      if (!ws) {
        log.info("[msg] no workspace for chat %s", msg.chatId);
        this.busyChats.delete(msg.chatId);
        await this.channel.sendMessage(msg.chatId, "No workspace linked to this group.");
        return;
      }

      log.info(`[turn] start session=${ws.current_session_id ?? "new"} cwd=${ws.cwd}`);
      await this.channel.setTyping(msg.chatId, true);

      // Append default workspace CLAUDE.md to non-default workspace sessions
      const appendSystemPrompt = this.readDefaultPrompt(ws.cwd);

      try {
        for await (const event of this.engine.runTurn({
          sessionId: ws.current_session_id,
          cwd: ws.cwd,
          prompt: msg.text,
          permissionMode: this.permissionMode,
          appendSystemPrompt,
          onPermissionRequest: async (req) => {
            log.info(`[perm] ${req.toolName}`);
            const resp = await this.channel.sendInteractive(
              msg.chatId,
              `Allow ${req.toolName}?\n${req.description}`,
              [
                { label: "Allow", value: "allow" },
                { label: "Deny", value: "deny" },
                { label: "Deny+Note", value: "deny", requestText: true },
              ],
            );
            log.info(`[perm] ${req.toolName} → ${resp.value || "timeout"}${resp.text ? ` "${resp.text}"` : ""}`);
            return {
              decision: resp.value === "allow" ? "allow" : "deny",
              message: resp.text,
            };
          },
        })) {
          await this.routeEngineEvent(msg.chatId, event, ws.name);
        }
      } finally {
        this.busyChats.delete(msg.chatId);
        await this.channel.setTyping(msg.chatId, false);
      }
    } catch (err) {
      log.error({ err }, "[fatal]");
      await this.channel.sendMessage(
        msg.chatId,
        `Internal error: ${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => {});
    }
  }

  private async routeEngineEvent(chatId: string, event: EngineEvent, workspaceName: string): Promise<void> {
    switch (event.type) {
      case "text":
        await this.channel.sendMessage(chatId, event.text);
        break;
      case "tool_use": {
        const formatted = formatToolUse(event.toolName, event.input);
        await this.channel.sendMessage(chatId, formatted, {
          parseMode: "MarkdownV2",
        });
        break;
      }
      case "tool_result": {
        const formatted = formatToolResult(event.toolName, event.output);
        if (formatted) {
          await this.channel.sendMessage(chatId, formatted, {
            parseMode: "MarkdownV2",
          });
        }
        break;
      }
      case "rate_limit": {
        const resetMsg = event.resetsAt
          ? ` Resets at ${new Date(event.resetsAt).toLocaleTimeString()}.`
          : "";
        log.warn(`[turn] rate limit: ${event.status}${resetMsg}`);
        await this.channel.sendMessage(
          chatId,
          `⚠️ Rate limited (${event.status}).${resetMsg}`,
        );
        break;
      }
      case "done":
        log.info(`[turn] done session=${event.sessionId}`);
        this.workspaceStore.setSession(workspaceName, event.sessionId);
        break;
      case "error":
        log.error(`[turn] error: ${event.message}`);
        await this.channel.sendMessage(
          chatId,
          `Error: ${event.message}`,
        );
        break;
    }
  }

  /** Read default workspace CLAUDE.md to append to non-default workspace sessions. */
  private readDefaultPrompt(workspaceCwd: string): string | undefined {
    if (workspaceCwd === path.dirname(this.defaultPromptPath)) return undefined;
    try {
      const content = fs.readFileSync(this.defaultPromptPath, "utf-8").trim();
      return content || undefined;
    } catch {
      return undefined;
    }
  }
}
