import log from "./logger.js";
import {
  getWorkspaceByChannel,
  upsertWorkspace,
  updateSessionId,
  clearSession,
} from "./db.js";
import { formatToolUse, formatToolResult } from "./format.js";
import type {
  Channel,
  Engine,
  EngineEvent,
  InboundMessage,
  PermissionMode,
} from "./types.js";

const DEFAULT_WORKSPACE = "main";

export interface OrchestratorOpts {
  channel: Channel;
  engine: Engine;
  channelId: string;
  defaultCwd: string;
  permissionMode: PermissionMode;
}

export class Orchestrator {
  private channel: Channel;
  private engine: Engine;
  private channelId: string;
  private defaultCwd: string;
  private permissionMode: PermissionMode;
  private busy = false;

  constructor(opts: OrchestratorOpts) {
    this.channel = opts.channel;
    this.engine = opts.engine;
    this.channelId = opts.channelId;
    this.defaultCwd = opts.defaultCwd;
    this.permissionMode = opts.permissionMode;
  }

  async start(): Promise<void> {
    // Seed default workspace if it doesn't exist
    if (!getWorkspaceByChannel(this.channelId)) {
      upsertWorkspace({
        name: DEFAULT_WORKSPACE,
        cwd: this.defaultCwd,
        channel_id: this.channelId,
        current_session_id: null,
      });
    }

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
        clearSession(DEFAULT_WORKSPACE);
        log.info("[cmd] session cleared");
        await this.channel.sendMessage(msg.channelId, "Session cleared.");
        return;
      }

      // Reject during active turn
      if (this.busy) {
        log.info("[msg] rejected (busy)");
        await this.channel.sendMessage(
          msg.channelId,
          "Still working on the previous message...",
        );
        return;
      }

      this.busy = true;
      const ws = getWorkspaceByChannel(msg.channelId);
      if (!ws) {
        log.info("[msg] no workspace for channel %s", msg.channelId);
        this.busy = false;
        return;
      }

      log.info(`[turn] start session=${ws.current_session_id ?? "new"} cwd=${ws.cwd}`);
      await this.channel.setTyping(msg.channelId, true);

      try {
        for await (const event of this.engine.runTurn({
          sessionId: ws.current_session_id,
          cwd: ws.cwd,
          prompt: msg.text,
          permissionMode: this.permissionMode,
          onPermissionRequest: async (req) => {
            log.info(`[perm] ${req.toolName}`);
            const resp = await this.channel.sendInteractive(
              msg.channelId,
              `Allow ${req.toolName}?`,
              [
                { label: "Allow", value: "allow" },
                { label: "Deny", value: "deny" },
              ],
            );
            log.info(`[perm] ${req.toolName} → ${resp.value || "timeout"}`);
            return {
              decision: resp.value === "allow" ? "allow" : "deny",
            };
          },
        })) {
          await this.routeEngineEvent(msg.channelId, event);
        }
      } finally {
        this.busy = false;
        await this.channel.setTyping(msg.channelId, false);
      }
    } catch (err) {
      log.error({ err }, "[fatal]");
      await this.channel.sendMessage(
        msg.channelId,
        `Internal error: ${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => {});
    }
  }

  private async routeEngineEvent(channelId: string, event: EngineEvent): Promise<void> {
    switch (event.type) {
      case "text":
        await this.channel.sendMessage(channelId, event.text);
        break;
      case "tool_use": {
        const formatted = formatToolUse(event.toolName, event.input);
        await this.channel.sendMessage(channelId, formatted, {
          parseMode: "MarkdownV2",
        });
        break;
      }
      case "tool_result": {
        const formatted = formatToolResult(event.toolName, event.output);
        if (formatted) {
          await this.channel.sendMessage(channelId, formatted, {
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
          channelId,
          `⚠️ Rate limited (${event.status}).${resetMsg}`,
        );
        break;
      }
      case "done":
        log.info(`[turn] done session=${event.sessionId}`);
        updateSessionId(DEFAULT_WORKSPACE, event.sessionId);
        break;
      case "error":
        log.error(`[turn] error: ${event.message}`);
        await this.channel.sendMessage(
          channelId,
          `Error: ${event.message}`,
        );
        break;
    }
  }
}
