import fs from "node:fs";
import path from "node:path";
import log from "./logger.js";
import { formatToolStatusLine, formatToolCallSummary, formatPermissionPrompt } from "./format.js";
import type { WorkspaceStore } from "./workspace-store.js";
import type {
  Channel,
  Engine,
  EngineEvent,
  InboundMessage,
  PermissionMode,
  TurnStats,
} from "./types.js";

export interface OrchestratorOpts {
  channel: Channel;
  engine: Engine;
  workspaceStore: WorkspaceStore;
  permissionMode: PermissionMode;
  defaultPromptPath: string;
}

interface ChatState {
  busy: boolean;
  abort: AbortController | null;
  permissionMode: PermissionMode | null; // null = use config default
  statusHandle: string | null; // pinned status message handle
  stats: TurnStats | null;
  // Rolling tool message: each tool_use replaces this single message's content
  toolCallHandle: string | null;
}

const MODE_OPTIONS: { label: string; value: PermissionMode }[] = [
  { label: "Default", value: "default" },
  { label: "Accept Edits", value: "acceptEdits" },
  { label: "Plan", value: "plan" },
  { label: "Bypass", value: "bypassPermissions" },
];

export class Orchestrator {
  private channel: Channel;
  private engine: Engine;
  private workspaceStore: WorkspaceStore;
  private permissionMode: PermissionMode;
  private defaultPromptPath: string;
  private chats = new Map<string, ChatState>();

  constructor(opts: OrchestratorOpts) {
    this.channel = opts.channel;
    this.engine = opts.engine;
    this.workspaceStore = opts.workspaceStore;
    this.permissionMode = opts.permissionMode;
    this.defaultPromptPath = opts.defaultPromptPath;
  }

  private chat(chatId: string): ChatState {
    let s = this.chats.get(chatId);
    if (!s) {
      s = {
        busy: false, abort: null, permissionMode: null, statusHandle: null, stats: null,
        toolCallHandle: null,
      };
      this.chats.set(chatId, s);
    }
    return s;
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
      log.info(`[msg] ${msg.user.name} (${msg.user.id}) ${msg.text.slice(0, 80)}`);

      const state = this.chat(msg.chatId);

      // /mode — switch permission mode (works even during active turns)
      if (msg.text === "/mode") {
        const currentMode = state.permissionMode ?? this.permissionMode;
        const buttons = [
          MODE_OPTIONS.slice(0, 2).map((opt) => ({
            label: opt.value === currentMode ? `✓ ${opt.label}` : opt.label,
            value: opt.value,
          })),
          MODE_OPTIONS.slice(2).map((opt) => ({
            label: opt.value === currentMode ? `✓ ${opt.label}` : opt.label,
            value: opt.value,
          })),
        ];
        const resp = await this.channel.sendInteractive(
          msg.chatId,
          `Current mode: ${MODE_OPTIONS.find((o) => o.value === currentMode)?.label ?? currentMode}`,
          buttons,
        );
        if (resp.value) {
          state.permissionMode = resp.value as PermissionMode;
          await this.updateStatusMessage(msg.chatId, state);
          log.info("[cmd] mode → %s", resp.value);
        }
        return;
      }

      // /new — reset session
      if (msg.text === "/new") {
        const ws = this.workspaceStore.byChat(msg.chatId);
        if (!ws) {
          await this.channel.sendMessage(msg.chatId, "No workspace linked to this group.");
          return;
        }
        this.workspaceStore.clearSession(ws.name);
        state.permissionMode = null;
        state.stats = null;
        await this.updateStatusMessage(msg.chatId, state);
        log.info("[cmd] session cleared for workspace %s", ws.name);
        await this.channel.sendMessage(msg.chatId, "Session cleared.");
        return;
      }

      // /cancel — abort the running turn
      if (msg.text === "/cancel") {
        if (state.abort) {
          state.abort.abort();
          log.info("[cmd] turn cancelled");
        } else {
          await this.channel.sendMessage(msg.chatId, "Nothing to cancel.");
        }
        return;
      }

      // Workspace lookup — guard all turn logic below
      const ws = this.workspaceStore.byChat(msg.chatId);
      if (!ws) {
        log.info("[msg] no workspace for chat %s", msg.chatId);
        await this.channel.sendMessage(msg.chatId, "No workspace linked to this group.");
        return;
      }

      // Reject during active turn (per-chat)
      if (state.busy) {
        log.info("[msg] rejected (busy)");
        await this.channel.sendMessage(
          msg.chatId,
          "Still working on the previous message...",
        );
        return;
      }

      state.busy = true;

      const abort = new AbortController();
      state.abort = abort;

      log.info(`[turn] start session=${ws.current_session_id ?? "new"} cwd=${ws.cwd}`);
      await this.channel.setTyping(msg.chatId, true);

      // Append default workspace CLAUDE.md to non-default workspace sessions
      const isDefaultWorkspace = ws.cwd === path.dirname(this.defaultPromptPath);
      const appendSystemPrompt = isDefaultWorkspace ? undefined : this.readDefaultPrompt();

      // In group workspaces, prepend sender identity so the engine knows who's talking
      const sender = msg.user.handle ? `${msg.user.name} (@${msg.user.handle})` : msg.user.name;
      const prompt = isDefaultWorkspace ? msg.text : `[${sender}]: ${msg.text}`;

      try {
        for await (const event of this.engine.runTurn({
          sessionId: ws.current_session_id,
          cwd: ws.cwd,
          prompt,
          permissionMode: state.permissionMode ?? this.permissionMode,
          appendSystemPrompt,
          signal: abort.signal,
          onPermissionRequest: async (req) => {
            log.info(`[perm] ${req.toolName}`);
            const promptText = formatPermissionPrompt(req.toolName, req.input, req.description);
            const resp = await this.channel.sendInteractive(
              msg.chatId,
              promptText,
              [
                [
                  { label: "👍 Allow", value: "allow" },
                  { label: "👎 Deny", value: "deny" },
                ],
                [
                  { label: "📝 Deny + Note", value: "deny", requestText: true },
                ],
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
        const cancelled = abort.signal.aborted;
        state.busy = false;
        state.abort = null;
        await this.channel.setTyping(msg.chatId, false);
        if (cancelled) {
          await this.channel.sendMessage(msg.chatId, "Turn cancelled.");
        }
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
    const state = this.chat(chatId);

    switch (event.type) {
      case "text":
        await this.channel.sendMessage(chatId, event.text);
        break;

      case "tool_use": {
        // Rolling message: each tool_use replaces the single message's content
        const line = formatToolStatusLine(event.toolName, event.input);
        if (state.toolCallHandle) {
          try {
            await this.channel.editMessage(chatId, state.toolCallHandle, line);
          } catch {
            const handles = await this.channel.sendMessage(chatId, line);
            state.toolCallHandle = handles[0];
          }
        } else {
          const handles = await this.channel.sendMessage(chatId, line);
          state.toolCallHandle = handles[0];
        }
        break;
      }

      case "tool_result":
        // All tool results suppressed — Claude summarizes in its text response
        break;

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

      case "done": {
        // Edit rolling tool message to show summary
        if (state.toolCallHandle && event.stats) {
          const summary = formatToolCallSummary(event.stats.toolCalls);
          if (summary) {
            try {
              await this.channel.editMessage(chatId, state.toolCallHandle, summary);
            } catch { /* edit failed, leave as-is */ }
          }
        }
        state.toolCallHandle = null;
        log.info(`[turn] done session=${event.sessionId}`);
        this.workspaceStore.setSession(workspaceName, event.sessionId);
        if (event.stats) state.stats = event.stats;
        await this.updateStatusMessage(chatId, state);
        break;
      }

      case "error":
        log.error(`[turn] error: ${event.message}`);
        await this.channel.sendMessage(
          chatId,
          `Error: ${event.message}`,
        );
        break;
    }
  }

  private async updateStatusMessage(chatId: string, state: ChatState): Promise<void> {
    const mode = state.permissionMode ?? this.permissionMode;
    const modeLabel = MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode;

    const parts: string[] = [];

    if (state.stats) {
      const pct = state.stats.contextWindow > 0
        ? Math.round((state.stats.contextUsed / state.stats.contextWindow) * 100)
        : 0;
      parts.push(`🤖 ${formatModelName(state.stats.model)} ${pct}% | 🔒 ${modeLabel}`);
    } else {
      parts.push(`🔒 ${modeLabel}`);
    }

    const text = parts.join("\n");
    if (state.statusHandle) {
      try {
        await this.channel.editMessage(chatId, state.statusHandle, text);
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("message is not modified"))) throw err;
      }
    } else {
      // Clear stale pins from previous server runs
      try { await this.channel.unpinAllMessages(chatId); } catch { /* not admin */ }
      const handles = await this.channel.sendMessage(chatId, text);
      state.statusHandle = handles[0];
      try {
        await this.channel.pinMessage(chatId, state.statusHandle);
      } catch (err) {
        log.warn("[cmd] failed to pin status message (bot may not be admin): %s",
          err instanceof Error ? err.message : String(err));
      }
    }
  }

  private async clearStatusMessage(chatId: string, state: ChatState): Promise<void> {
    if (!state.statusHandle) return;
    try {
      await this.channel.deleteMessage(chatId, state.statusHandle);
    } catch (err) {
      log.warn("[cmd] failed to delete status message: %s",
        err instanceof Error ? err.message : String(err));
    }
    state.statusHandle = null;
  }

  /** Read default workspace CLAUDE.md to append to non-default workspace sessions. */
  private readDefaultPrompt(): string | undefined {
    try {
      const content = fs.readFileSync(this.defaultPromptPath, "utf-8").trim();
      return content || undefined;
    } catch {
      return undefined;
    }
  }
}

/** Strip "claude-" prefix and date suffix from model ID. e.g. "claude-opus-4-6-20250514" → "opus-4-6" */
function formatModelName(modelId: string): string {
  return modelId.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
