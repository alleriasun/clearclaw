import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import log from "./logger.js";
import { saveFile } from "./files.js";
import { formatToolStatusLine, formatToolCallSummary, formatPermissionPrompt, timeAgo } from "./format.js";
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
  filesPath: string;
}

interface ChatState {
  busy: boolean;
  abort: AbortController | null;
  permissionMode: PermissionMode | null; // null = use config default
  stats: TurnStats | null;
  lastStatusText: string | null; // dedup: skip updateStatus when text unchanged
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
  private filesPath: string;
  private chats = new Map<string, ChatState>();

  constructor(opts: OrchestratorOpts) {
    this.channel = opts.channel;
    this.engine = opts.engine;
    this.workspaceStore = opts.workspaceStore;
    this.permissionMode = opts.permissionMode;
    this.defaultPromptPath = opts.defaultPromptPath;
    this.filesPath = opts.filesPath;
  }

  private chat(chatId: string): ChatState {
    let s = this.chats.get(chatId);
    if (!s) {
      s = {
        busy: false, abort: null, permissionMode: null, stats: null, lastStatusText: null,
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

      // /resume — switch to a previous session
      if (msg.text === "/resume") {
        if (state.busy) {
          await this.channel.sendMessage(
            msg.chatId,
            "A turn is in progress. Wait for it to finish before switching sessions.",
          );
          return;
        }
        const ws = this.workspaceStore.byChat(msg.chatId);
        if (!ws) {
          await this.channel.sendMessage(msg.chatId, "No workspace linked to this group.");
          return;
        }
        const sessions = await this.engine.listSessions(ws.cwd);
        if (sessions.length === 0) {
          await this.channel.sendMessage(msg.chatId, "No sessions found for this workspace.");
          return;
        }
        const MAX_BTN = 45;
        // Strip ClearClaw's "[User (@handle)]: " prefix from SDK summaries
        const stripped = sessions.map((s) => ({
          ...s,
          summary: s.summary.replace(/^\[.*?\]:\s*/, ""),
        }));
        // Build detailed list for message body
        const listing = stripped.map((s, i) => {
          const current = s.sessionId === ws.current_session_id ? " ✅" : "";
          const meta = [timeAgo(s.lastModified), s.gitBranch].filter(Boolean).join(" · ");
          return `${i + 1}. ${s.summary}${current}\n   ${meta}`;
        }).join("\n");
        // Concise button labels (single line)
        const buttons = stripped.map((s, i) => {
          const label = `${i + 1}. ${s.summary}`;
          const truncated = label.length > MAX_BTN
            ? label.slice(0, MAX_BTN - 1) + "…"
            : label;
          return [{ label: truncated, value: s.sessionId }];
        });
        const resp = await this.channel.sendInteractive(
          msg.chatId,
          `Pick a session to resume:\n\n${listing}`,
          buttons,
        );
        if (resp.value) {
          this.workspaceStore.setSession(ws.name, resp.value);
          const picked = stripped.find((s) => s.sessionId === resp.value);
          await this.channel.sendMessage(
            msg.chatId,
            `Resumed session: ${picked?.summary ?? resp.value}`,
          );
          log.info("[cmd] resumed session %s for workspace %s", resp.value, ws.name);
        }
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

      // Save attachments to disk for the audit log (failures must not block the turn)
      if (msg.attachments?.length) {
        const results = await Promise.allSettled(
          msg.attachments.map((att) => saveFile(att, ws.name, this.filesPath)),
        );
        for (const r of results) {
          if (r.status === "rejected") log.warn({ err: r.reason }, "[turn] failed to save attachment");
        }
        const saved = results.filter((r) => r.status === "fulfilled").length;
        if (saved > 0) log.info("[turn] saved %d/%d attachment(s) for workspace %s", saved, msg.attachments.length, ws.name);
      }

      const mcpServer = createSdkMcpServer({
        name: "clearclaw",
        tools: [
          tool("send_file", "Send a file or image to the current chat conversation", {
            file_path: z.string().optional().describe("Absolute path to the file to send"),
            data: z.string().optional().describe("Base64-encoded file data (alternative to file_path)"),
            filename: z.string().optional().describe("Filename (required when using data, optional with file_path)"),
            caption: z.string().optional().describe("Optional caption to accompany the file"),
          }, async (args) => {
            if (!args.file_path && !args.data) throw new Error("Either file_path or data must be provided");
            const buffer = args.file_path
              ? await fs.promises.readFile(args.file_path)
              : Buffer.from(args.data!, "base64");
            const name = args.filename ?? path.basename(args.file_path ?? "file");
            await this.channel.sendFile(msg.chatId, buffer, name, { caption: args.caption });
            return { content: [{ type: "text" as const, text: `Sent ${name} to chat` }] };
          }),
        ],
      });

      try {
        for await (const event of this.engine.runTurn({
          sessionId: ws.current_session_id,
          cwd: ws.cwd,
          prompt,
          attachments: msg.attachments,
          permissionMode: state.permissionMode ?? this.permissionMode,
          appendSystemPrompt,
          mcpServers: { clearclaw: mcpServer },
          signal: abort.signal,
          onPermissionRequest: async (req) => {
            // Auto-allow ClearClaw's own MCP tools — no chat prompt needed
            if (req.toolName.startsWith("mcp__clearclaw__")) {
              log.info(`[perm] ${req.toolName} → auto-allow`);
              return { decision: "allow" };
            }
            log.info(`[perm] ${req.toolName}`);
            try {
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
            } catch (err) {
              log.warn({ err }, "[perm] failed to send prompt for %s, auto-denying", req.toolName);
              return {
                decision: "deny" as const,
                message: "Permission prompt could not be delivered to chat — denied automatically.",
              };
            }
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

    try {
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
              const handles = await this.channel.sendMessage(chatId, line, { consumeTyping: false });
              state.toolCallHandle = handles[0];
            }
          } else {
            const handles = await this.channel.sendMessage(chatId, line, { consumeTyping: false });
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
          // Persist state first — channel calls below are best-effort
          log.info(`[turn] done session=${event.sessionId}`);
          this.workspaceStore.setSession(workspaceName, event.sessionId);
          if (event.stats) state.stats = event.stats;

          // Best-effort: update tool summary and status message
          if (state.toolCallHandle && event.stats) {
            const summary = formatToolCallSummary(event.stats.toolCalls);
            if (summary) {
              try {
                await this.channel.editMessage(chatId, state.toolCallHandle, summary);
              } catch { /* edit failed, leave as-is */ }
            }
          }
          state.toolCallHandle = null;
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
    } catch (err) {
      // Channel errors must never propagate — they'd crash the engine turn loop,
      // killing the SDK session and losing the session ID.
      log.warn({ err }, "[route] failed to relay %s event to channel", event.type);
    }
  }

  private async updateStatusMessage(chatId: string, state: ChatState): Promise<void> {
    const mode = state.permissionMode ?? this.permissionMode;
    const modeLabel = MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode;

    let text: string;
    if (state.stats) {
      const pct = state.stats.contextWindow > 0
        ? Math.round((state.stats.contextUsed / state.stats.contextWindow) * 100)
        : 0;
      text = `🤖 ${formatModelName(state.stats.model)} ${pct}% | 🔒 ${modeLabel}`;
    } else {
      text = `🔒 ${modeLabel}`;
    }

    if (text === state.lastStatusText) return;
    await this.channel.updateStatus(chatId, text);
    state.lastStatusText = text;
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
