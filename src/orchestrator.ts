import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import log from "./logger.js";
import { saveFile } from "./files.js";
import { formatToolStatusLine, formatToolCallSummary, formatPermissionPrompt, formatTodoList, timeAgo } from "./format.js";
import { permissionHandlers, displayHandledTools } from "./tool-handlers.js";
import type { WorkspaceStore } from "./workspace-store.js";
import type {
  Channel,
  Engine,
  EngineEvent,
  InboundMessage,
  PermissionMode,
  ReplyContext,
  TurnStats,
  Workspace,
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
  todoHandle: string | null;
  // Per-chat message queue: relay drains immediately, assistant debounces
  messageQueue: InboundMessage[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
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
        toolCallHandle: null, todoHandle: null,
        messageQueue: [], debounceTimer: null,
      };
      this.chats.set(chatId, s);
    }
    return s;
  }

  async start(): Promise<void> {
    this.channel.on("message", (msg) => {
      this.routeMessage(msg).catch((err) => {
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

  /** Effective behavior for a workspace: explicit setting, or home→assistant / project→relay. */
  private effectiveBehavior(ws: Workspace): "assistant" | "relay" {
    if (ws.behavior !== undefined) return ws.behavior;
    return ws.cwd === path.dirname(this.defaultPromptPath) ? "assistant" : "relay";
  }

  /** Enqueue a message and either drain immediately (relay) or start debounce (assistant). */
  private enqueueMessage(msg: InboundMessage, ws: Workspace, state: ChatState): void {
    state.messageQueue.push(msg);
    if (state.busy) return; // processQueuedMessages will pick up after current turn completes

    if (this.effectiveBehavior(ws) === "assistant") {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      this.scheduleDebounce(msg.chatId);
    } else {
      this.processQueuedMessages(msg.chatId).catch((err) => {
        log.error({ err }, "[orchestrator] drain error");
      });
    }
  }

  private scheduleDebounce(chatId: string): void {
    const state = this.chat(chatId);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      this.processQueuedMessages(chatId).catch((err) => {
        log.error({ err }, "[orchestrator] drain error");
      });
    }, 1000);
  }

  private async processQueuedMessages(chatId: string): Promise<void> {
    const state = this.chat(chatId);
    if (state.messageQueue.length === 0 || state.busy) return;

    const ws = this.workspaceStore.byChat(chatId);
    if (!ws) return;

    const messages = [...state.messageQueue];
    state.messageQueue = [];

    try {
      await this.executeTurn(chatId, messages, ws, state);
    } catch (err) {
      log.error({ err }, "[fatal]");
      await this.channel.sendMessage(
        chatId,
        `Internal error: ${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => {});
      return;
    }

    // Post-turn drain: new messages may have arrived while the turn was running
    if (state.messageQueue.length > 0) {
      if (this.effectiveBehavior(ws) === "assistant") {
        this.scheduleDebounce(chatId);
      } else {
        this.processQueuedMessages(chatId).catch((err) => {
          log.error({ err }, "[orchestrator] drain error");
        });
      }
    }
  }

  private async executeTurn(
    chatId: string,
    messages: InboundMessage[],
    ws: Workspace,
    state: ChatState,
  ): Promise<void> {
    state.busy = true;
    const abort = new AbortController();
    state.abort = abort;

    const behavior = this.effectiveBehavior(ws);
    const turnState = { staySilent: false, replyToMessageId: null as string | null };

    log.info(`[turn] start behavior=${behavior} session=${ws.current_session_id ?? "new"} msgs=${messages.length} cwd=${ws.cwd}`);
    await this.channel.setTyping(chatId, true);

    const isHomeWorkspace = ws.cwd === path.dirname(this.defaultPromptPath);
    const appendSystemPrompt = isHomeWorkspace ? undefined : this.readDefaultPrompt();

    const prompt = buildPrompt(messages);

    // Save all attachments to disk for the audit log
    const allAttachments = messages.flatMap((m) => m.attachments ?? []);
    if (allAttachments.length) {
      const results = await Promise.allSettled(
        allAttachments.map((att) => saveFile(att, ws.name, this.filesPath)),
      );
      for (const r of results) {
        if (r.status === "rejected") log.warn({ err: r.reason }, "[turn] failed to save attachment");
      }
      const saved = results.filter((r) => r.status === "fulfilled").length;
      if (saved > 0) log.info("[turn] saved %d/%d attachment(s) for workspace %s", saved, allAttachments.length, ws.name);
    }

    const mcpServer = createSdkMcpServer({
      name: "clearclaw",
      tools: this.buildMcpTools(chatId, behavior, turnState),
    });

    try {
      for await (const event of this.engine.runTurn({
        sessionId: ws.current_session_id,
        cwd: ws.cwd,
        prompt,
        attachments: allAttachments.length > 0 ? allAttachments : undefined,
        permissionMode: state.permissionMode ?? (behavior === "assistant" ? "bypassPermissions" : this.permissionMode),
        appendSystemPrompt,
        mcpServers: { clearclaw: mcpServer },
        signal: abort.signal,
        onPermissionRequest: (req) => this.handlePermission(req, chatId),
      })) {
        await this.routeEngineEvent(chatId, event, ws.name, behavior, turnState);
      }
    } finally {
      const cancelled = abort.signal.aborted;
      state.busy = false;
      state.abort = null;
      if (!turnState.staySilent) {
        await this.channel.setTyping(chatId, false);
      }
      if (cancelled) {
        await this.channel.sendMessage(chatId, "Turn cancelled.");
      }
    }
  }

  private async routeMessage(msg: InboundMessage): Promise<void> {
    try {
      log.info(`[msg] ${msg.user.name} (${msg.user.id}) ${msg.text.slice(0, 80)}`);

      const state = this.chat(msg.chatId);
      const ws = this.workspaceStore.byChat(msg.chatId);

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

      // /behavior — switch workspace behavior (assistant or relay)
      if (msg.text === "/behavior") {
        if (!ws) {
          await this.channel.sendMessage(msg.chatId, "No workspace linked to this chat.");
          return;
        }
        const current = this.effectiveBehavior(ws);
        const resp = await this.channel.sendInteractive(
          msg.chatId,
          `Current behavior: ${current}`,
          [
            [
              { label: current === "assistant" ? "✓ Assistant" : "Assistant", value: "assistant" },
              { label: current === "relay" ? "✓ Relay" : "Relay", value: "relay" },
            ],
          ],
        );
        if (resp.value === "assistant" || resp.value === "relay") {
          this.workspaceStore.setBehavior(ws.name, resp.value);
          await this.updateStatusMessage(msg.chatId, this.chat(msg.chatId));
          log.info("[cmd] workspace %s behavior → %s", ws.name, resp.value);
        }
        return;
      }

      if (!ws) {
        log.info("[msg] no workspace for chat %s", msg.chatId);
        await this.channel.sendMessage(msg.chatId, "No workspace linked to this group.");
        return;
      }

      this.enqueueMessage(msg, ws, state);
    } catch (err) {
      log.error({ err }, "[fatal]");
      await this.channel.sendMessage(
        msg.chatId,
        `Internal error: ${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => {});
    }
  }

  private async routeEngineEvent(
    chatId: string,
    event: EngineEvent,
    workspaceName: string,
    behavior: "assistant" | "relay",
    turnState: { staySilent: boolean; replyToMessageId: string | null },
  ): Promise<void> {
    const state = this.chat(chatId);

    try {
      switch (event.type) {
        case "text":
          if (turnState.staySilent) break;
          await this.channel.sendMessage(chatId, event.text, {
            replyToMessageId: turnState.replyToMessageId ?? undefined,
          });
          break;

        case "tool_use": {
          // In assistant behavior, all tool status is suppressed (no rolling status, no plan mode notifications)
          if (behavior === "assistant") break;

          // Relay behavior: existing display logic
          if (event.toolName === "TodoWrite") {
            const text = formatTodoList(event.input);
            if (state.todoHandle) {
              try {
                await this.channel.editMessage(chatId, state.todoHandle, text);
              } catch {
                const handles = await this.channel.sendMessage(chatId, text, { consumeTyping: false });
                state.todoHandle = handles[0];
              }
            } else {
              const handles = await this.channel.sendMessage(chatId, text, { consumeTyping: false });
              state.todoHandle = handles[0];
            }
            break;
          }

          if (event.toolName === "EnterPlanMode") {
            await this.channel.sendMessage(chatId, "📋 Planning");
            break;
          }

          if (displayHandledTools.has(event.toolName)) break;

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
          break;

        case "rate_limit": {
          const resetMsg = event.resetsAt
            ? ` Resets at ${new Date(event.resetsAt).toLocaleTimeString()}.`
            : "";
          log.warn(`[turn] rate limit: ${event.status}${resetMsg}`);
          await this.channel.sendMessage(chatId, `⚠️ Rate limited (${event.status}).${resetMsg}`);
          break;
        }

        case "done": {
          log.info(`[turn] done session=${event.sessionId}`);
          this.workspaceStore.setSession(workspaceName, event.sessionId);
          if (event.stats) state.stats = event.stats;

          // Tool summary only in relay behavior
          if (behavior === "relay" && state.toolCallHandle && event.stats) {
            const summary = formatToolCallSummary(event.stats.toolCalls);
            if (summary) {
              try {
                await this.channel.editMessage(chatId, state.toolCallHandle, summary);
              } catch { /* edit failed, leave as-is */ }
            }
          }
          state.toolCallHandle = null;
          state.todoHandle = null;
          await this.updateStatusMessage(chatId, state);
          break;
        }

        case "error":
          log.error(`[turn] error: ${event.message}`);
          await this.channel.sendMessage(chatId, `Error: ${event.message}`);
          break;
      }
    } catch (err) {
      // Channel errors must never propagate — they'd crash the engine turn loop,
      // killing the SDK session and losing the session ID.
      log.warn({ err }, "[route] failed to relay %s event to channel", event.type);
    }
  }

  private buildMcpTools(
    chatId: string,
    behavior: "assistant" | "relay",
    turnState: { staySilent: boolean; replyToMessageId: string | null },
  ) {
    type McpTool = NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]>[number];
    const tools: McpTool[] = [
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
        await this.channel.sendFile(chatId, buffer, name, { caption: args.caption });
        return { content: [{ type: "text" as const, text: `Sent ${name} to chat` }] };
      }),
    ];

    if (behavior === "assistant") {
      tools.push(
        tool("stay_silent", "Stay silent — do not send any text response for this turn", {}, async () => {
          turnState.staySilent = true;
          await this.channel.setTyping(chatId, false); // suppress typing indicator immediately
          return { content: [{ type: "text" as const, text: "Silent turn" }] };
        }),
        tool("react", "React to a specific message with an emoji", {
          message: z.string().describe("Platform message ID from [msg:N] tag"),
          emoji: z.string().describe("Single emoji character"),
        }, async (args) => {
          await this.channel.reactToMessage(chatId, args.message, args.emoji);
          return { content: [{ type: "text" as const, text: `Reacted to ${args.message} with ${args.emoji}` }] };
        }),
        tool("reply_to", "Thread the text response as a reply to a specific message", {
          message: z.string().describe("Platform message ID from [msg:N] tag"),
        }, async (args) => {
          turnState.replyToMessageId = args.message;
          return { content: [{ type: "text" as const, text: `Will reply to message ${args.message}` }] };
        }),
      );
    }

    return tools;
  }

  private async handlePermission(
    req: { toolName: string; input: Record<string, unknown>; description: string },
    chatId: string,
  ): Promise<{ decision: "allow" | "deny"; message?: string; updatedInput?: Record<string, unknown> }> {
    // Always auto-allow ClearClaw's own MCP tools
    if (req.toolName.startsWith("mcp__clearclaw__")) {
      log.info(`[perm] ${req.toolName} → auto-allow`);
      return { decision: "allow" };
    }

    log.info(`[perm] ${req.toolName}`);

    // Custom tool handler
    const handler = permissionHandlers.get(req.toolName);
    if (handler) {
      const result = handler(req.input, req.description);
      if (result === null) {
        log.info(`[perm] ${req.toolName} → auto-allow (handler)`);
        await this.channel.sendMessage(chatId, "📋 Entering plan mode");
        return { decision: "allow" };
      }
      try {
        const resp = await this.channel.sendInteractive(chatId, result.text, result.buttons);
        log.info(`[perm] ${req.toolName} → ${resp.value || "timeout"}${resp.text ? ` "${resp.text}"` : ""}`);
        return result.mapResponse(resp);
      } catch (err) {
        log.warn({ err }, "[perm] failed to send prompt for %s, auto-denying", req.toolName);
        return { decision: "deny" as const, message: "Permission prompt could not be delivered to chat — denied automatically." };
      }
    }

    try {
      const resp = await this.channel.sendInteractive(
        chatId,
        formatPermissionPrompt(req.toolName, req.input, req.description),
        [
          [{ label: "👍 Allow", value: "allow" }, { label: "👎 Deny", value: "deny" }],
          [{ label: "📝 Deny + Note", value: "deny", requestText: true }],
        ],
      );
      log.info(`[perm] ${req.toolName} → ${resp.value || "timeout"}${resp.text ? ` "${resp.text}"` : ""}`);
      return { decision: resp.value === "allow" ? "allow" : "deny", message: resp.text };
    } catch (err) {
      log.warn({ err }, "[perm] failed to send prompt for %s, auto-denying", req.toolName);
      return { decision: "deny" as const, message: "Permission prompt could not be delivered to chat — denied automatically." };
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

/** Format reply context as a bracketed prefix line for the LLM prompt. */
function formatReplyLine(replyTo?: ReplyContext): string {
  if (!replyTo) return "";
  const parts: string[] = [];
  if (replyTo.senderName) parts.push(replyTo.senderName);
  parts.push(`msg:${replyTo.messageId}`);
  if (replyTo.mediaType) parts.push(`[${replyTo.mediaType}]`);
  if (replyTo.text) parts.push(`"${replyTo.text}"`);
  return `[Replying to ${parts.join(" ")}]\n`;
}

/**
 * Build the turn prompt: `[msg:N] sender: text`, one line per message.
 * Works for both single-message (relay) and batched (assistant) turns.
 */
function buildPrompt(messages: InboundMessage[]): string {
  return messages.map((msg) => {
    const sender = msg.user.handle ? `${msg.user.name} (@${msg.user.handle})` : msg.user.name;
    const msgIdPrefix = msg.messageId ? `[msg:${msg.messageId}] ` : "";
    const replyLine = formatReplyLine(msg.replyTo);
    const attachmentNote = msg.attachments?.length
      ? ` [${msg.attachments.length} attachment(s)]`
      : "";
    return `${replyLine}${msgIdPrefix}${sender}: ${msg.text}${attachmentNote}`;
  }).join("\n");
}

