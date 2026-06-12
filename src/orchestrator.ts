import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import log from "./logger.js";
import { saveFile } from "./files.js";
import { assemblePrompt } from "./prompt.js";
import { formatToolStatusLine, formatToolCallSummary, formatPermissionPrompt, formatTodoList, timeAgo } from "./format.js";
import { permissionHandlers, displayHandledTools } from "./tool-handlers.js";
import { Scheduler } from "./scheduler.js";
import type { Config, PendingSpinOut, ScheduleEntry } from "./config.js";
import type {
  Channel,
  Engine,
  EngineEvent,
  InboundMessage,
  MessageOrigin,
  PermissionMode,
  ReplyContext,
  ToolCall,
  TurnStats,
  Workspace,
} from "./types.js";

export interface OrchestratorOpts {
  channel: Channel;
  engines: Map<string, Engine>;
  config: Config;
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
  // Rolling text message: streaming engines (text_chunk) accumulate here
  textHandle: string | null;
  textBuffer: string;
  engineName: string | null; // engine name for status display when model is null
  // Per-chat message queue: relay drains immediately, assistant debounces
  messageQueue: InboundMessage[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

interface TaskState {
  sessionId: string | null;
  cwd: string;
  prompt: string;
}

type TurnContext = Workspace | TaskState;

function isTask(ctx: TurnContext): ctx is TaskState {
  return "prompt" in ctx;
}

const MODE_OPTIONS: { label: string; value: PermissionMode }[] = [
  { label: "Default", value: "default" },
  { label: "Accept Edits", value: "acceptEdits" },
  { label: "Plan", value: "plan" },
  { label: "Bypass", value: "bypassPermissions" },
];


export class Orchestrator {
  private channel: Channel;
  private engines: Map<string, Engine>;
  private config: Config;
  private chats = new Map<string, ChatState>();
  private tasks = new Map<string, TaskState>();
  private scheduler: Scheduler | null = null;

  constructor(opts: OrchestratorOpts) {
    this.channel = opts.channel;
    this.engines = opts.engines;
    this.config = opts.config;
  }

  private chat(chatId: string): ChatState {
    let s = this.chats.get(chatId);
    if (!s) {
      s = {
        busy: false, abort: null, permissionMode: null, stats: null, lastStatusText: null,
        toolCallHandle: null, todoHandle: null, textHandle: null, textBuffer: "",
        engineName: null,
        messageQueue: [], debounceTimer: null,
      };
      this.chats.set(chatId, s);
    }
    return s;
  }

  private engineFor(ws: Workspace): Engine {
    const name = ws.engine ?? this.config.defaultEngine;
    const engine = this.engines.get(name);
    if (!engine) {
      throw new Error(`Unknown engine "${name}" configured for workspace "${ws.name}". Available: ${[...this.engines.keys()].join(", ")}`);
    }
    return engine;
  }

  async start(): Promise<void> {
    this.channel.on("message", (msg) => {
      this.routeMessage(msg).catch((err) => {
        log.error({ err }, "[orchestrator] unhandled message error");
      });
    });

    await this.channel.connect();
    log.info("ClearClaw ready.");

    this.scheduler = new Scheduler(this.config, (msg) => this.deliverToWorkspace("default", msg.origin, msg.text));
    this.scheduler.start();

    const shutdown = async () => {
      await this.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  async stop(): Promise<void> {
    this.scheduler?.stop();
    await this.channel.disconnect();
  }

  /** Deliver a synthetic message to a named workspace and trigger its turn. */
  public deliverToWorkspace(workspaceName: string, origin: MessageOrigin, text: string): boolean {
    const ws = this.config.workspaceByName(workspaceName);
    if (!ws) {
      log.warn("[deliver] workspace '%s' not found", workspaceName);
      return false;
    }
    const msg: InboundMessage = {
      chatId: ws.chat_id,
      chatType: ws.name === "default" ? "dm" : "group",
      text,
      origin,
    };
    this.enqueueMessage(msg, ws, this.chat(ws.chat_id));
    return true;
  }

  /** Effective behavior: tasks→assistant, workspace→explicit setting or home→assistant / project→relay. */
  private effectiveBehavior(ctx: TurnContext): "assistant" | "relay" {
    if (isTask(ctx)) return "assistant";
    if (ctx.behavior !== undefined) return ctx.behavior;
    return ctx.cwd === this.config.homeWorkspacePath ? "assistant" : "relay";
  }

  /** Enqueue a message and drain — immediately for relay, debounced for assistant/task. */
  private enqueueMessage(msg: InboundMessage, ctx: TurnContext, state: ChatState): void {
    log.info("[msg] %s: %s", senderLabel(msg.origin), msg.text.slice(0, 80));
    state.messageQueue.push(msg);
    if (state.busy) return;

    if (this.effectiveBehavior(ctx) === "assistant") {
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

    const ctx: TurnContext | undefined =
      this.tasks.get(chatId) ?? this.config.workspaceByChat(chatId);
    if (!ctx) return;

    const messages = [...state.messageQueue];
    state.messageQueue = [];

    try {
      await this.executeTurn(chatId, messages, ctx, state);
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
      if (this.effectiveBehavior(ctx) === "assistant") {
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
    ctx: TurnContext,
    state: ChatState,
  ): Promise<void> {
    const task = isTask(ctx) ? ctx : undefined;
    const ws = isTask(ctx) ? undefined : ctx;

    state.busy = true;
    const abort = new AbortController();
    state.abort = abort;

    const behavior = messages.some((m) => m.origin.kind === "scheduler")
      ? "assistant" as const
      : this.effectiveBehavior(ctx);
    const turnState = { staySilent: false, replyToMessageId: null as string | null };
    const sessionId = task ? task.sessionId : ws!.current_session_id;
    const cwd = task ? task.cwd : ws!.cwd;
    const logPrefix = task ? "[task-turn]" : "[turn]";

    log.info("%s start session=%s msgs=%d cwd=%s", logPrefix, sessionId ?? "new", messages.length, cwd);
    await this.channel.setTyping(chatId, true);

    const assembledPrompt = assemblePrompt(
      this.config.frameworkPromptDir,
      this.config.instructionsDir,
    );
    const appendSystemPrompt = task
      ? (assembledPrompt ? `${assembledPrompt}\n\n${task.prompt}` : task.prompt)
      : assembledPrompt;

    const prompt = buildPrompt(messages);

    // Save attachments for workspace turns
    const allAttachments = messages.flatMap((m) => m.attachments ?? []);
    if (ws && allAttachments.length) {
      const results = await Promise.allSettled(
        allAttachments.map((att) => saveFile(att, ws.name, this.config.filesPath)),
      );
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === "fulfilled") {
          allAttachments[i].savedAs = r.value;
        } else {
          log.warn({ err: r.reason }, "[turn] failed to save attachment");
        }
      }
      const saved = results.filter((r) => r.status === "fulfilled").length;
      if (saved > 0) log.info("[turn] saved %d/%d attachment(s) for workspace %s", saved, allAttachments.length, ws.name);
    }

    const mcpServer = createSdkMcpServer({
      name: "clearclaw",
      tools: this.buildMcpTools(chatId, behavior, turnState),
    });

    const engine = ws ? this.engineFor(ws) : this.engines.get(this.config.defaultEngine)!;
    state.engineName = engine.name;

    try {
      for await (const event of engine.runTurn({
        sessionId,
        cwd,
        prompt,
        attachments: ws && allAttachments.length > 0 ? allAttachments : undefined,
        permissionMode: state.permissionMode ?? (behavior === "assistant" ? "bypassPermissions" : this.config.permissionMode),
        appendSystemPrompt,
        mcpServers: { clearclaw: mcpServer },
        signal: abort.signal,
        onPermissionRequest: (req) => this.handlePermission(req, chatId),
      })) {
        // Handle done event inline — task vs workspace need different session storage
        if (event.type === "done") {
          log.info("%s done session=%s", logPrefix, event.sessionId);
          if (task) {
            const currentTask = this.tasks.get(chatId);
            if (currentTask) currentTask.sessionId = event.sessionId;
          } else {
            this.config.setSession(ws!.name, event.sessionId);
          }
          if (event.stats) state.stats = event.stats;
          if (behavior === "relay" && state.toolCallHandle && event.stats) {
            const summary = formatToolCallSummary(event.stats.toolCalls);
            if (summary) {
              try { await this.channel.editMessage(chatId, state.toolCallHandle, summary); } catch { /* */ }
            }
          }
          state.toolCallHandle = null;
          state.todoHandle = null;
          // Final formatted edit for any pending streaming text
          if (state.textHandle && state.textBuffer) {
            try {
              await this.channel.editMessage(chatId, state.textHandle, state.textBuffer);
            } catch { /* best effort */ }
          }
          state.textHandle = null;
          state.textBuffer = "";
          await this.updateStatusMessage(chatId, state);
          break;
        }
        await this.routeEngineEvent(chatId, event, ws?.name ?? "", behavior, turnState);
      }
    } finally {
      const cancelled = abort.signal.aborted;
      state.busy = false;
      state.abort = null;
      if (!turnState.staySilent) {
        await this.channel.setTyping(chatId, false);
      }
      // Task cancel already sent "Setup cancelled" from /cancel handler
      if (cancelled && !task) {
        await this.channel.sendMessage(chatId, "Turn cancelled.");
      }
    }
  }

  private async routeMessage(msg: InboundMessage): Promise<void> {
    try {
      // routeMessage only handles channel-emitted messages, which are always user-originated.
      if (msg.origin.kind !== "user") return; // unreachable; documents + type-narrows the invariant
      const { user } = msg.origin;

      const state = this.chat(msg.chatId);

      // /cancel — abort running turn or clear active task (must come before task routing)
      if (msg.text === "/cancel") {
        const task = this.tasks.get(msg.chatId);
        if (task) {
          this.tasks.delete(msg.chatId);
          if (state.abort) state.abort.abort();
          log.info("[cmd] task cancelled for chat %s", msg.chatId);
          await this.channel.sendMessage(msg.chatId, "Setup cancelled.");
          return;
        }
        if (state.abort) {
          state.abort.abort();
          log.info("[cmd] turn cancelled");
        } else {
          await this.channel.sendMessage(msg.chatId, "Nothing to cancel.");
        }
        return;
      }

      // Task routing — takes priority over workspace and all other commands
      const existingTask = this.tasks.get(msg.chatId);
      if (existingTask) {
        this.enqueueMessage(msg, existingTask, state);
        return;
      }

      const ws = this.config.workspaceByChat(msg.chatId);

      // /mode — switch permission mode (works even during active turns)
      if (msg.text === "/mode") {
        const currentMode = state.permissionMode ?? this.config.permissionMode;
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
        this.config.clearSession(ws.name);
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
        const sessions = await this.engineFor(ws).listSessions(ws.cwd);
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
          this.config.setSession(ws.name, resp.value);
          const picked = stripped.find((s) => s.sessionId === resp.value);
          await this.channel.sendMessage(
            msg.chatId,
            `Resumed session: ${picked?.summary ?? resp.value}`,
          );
          log.info("[cmd] resumed session %s for workspace %s", resp.value, ws.name);
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
          this.config.setBehavior(ws.name, resp.value);
          await this.updateStatusMessage(msg.chatId, this.chat(msg.chatId));
          log.info("[cmd] workspace %s behavior → %s", ws.name, resp.value);
        }
        return;
      }

      if (!ws) {
        if (this.config.isAuthorized(user.id)) {
          const chatType = msg.chatType === "dm" ? "DM" : "group";
          const promptLines = [
            "THIS IS A TASK SESSION — not a regular conversation.",
            "Do NOT follow the 'Every Session' startup routine. Do NOT read MEMORY.md or daily notes. Do NOT greet the user.",
            `This is a ${chatType} chat. Home workspace path: ${this.config.homeWorkspacePath}`,
            "Follow the Workspace Onboarding instructions in the system prompt.",
          ];
          const spinOuts = this.config.listSpinOuts();
          if (spinOuts.length > 0) {
            promptLines.push(
              "",
              "Pending spin-outs (if this chat was created for one, offer to claim it via workspace_create's spin_out_id):",
              ...spinOuts.map((s) => `- ${s.id}: "${s.name}" from workspace ${s.fromWorkspace}${s.suggestedCwd ? `, suggested cwd ${s.suggestedCwd}` : ""} — ${s.brief.slice(0, 200)}`),
            );
          }
          const newTask: TaskState = {
            sessionId: null,
            cwd: this.config.homeWorkspacePath,
            prompt: promptLines.join("\n"),
          };
          this.tasks.set(msg.chatId, newTask);
          log.info("[task] onboarding started for chat %s", msg.chatId);
          this.enqueueMessage(msg, newTask, state);
        } else {
          log.info("[msg] no workspace for chat %s", msg.chatId);
          await this.channel.sendMessage(msg.chatId, "No workspace linked to this chat.");
        }
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

        case "text_chunk": {
          if (turnState.staySilent) break;
          state.textBuffer += event.text;
          const plainOpts = { format: "plain" as const };
          if (state.textHandle) {
            try {
              await this.channel.editMessage(chatId, state.textHandle, state.textBuffer, plainOpts);
            } catch {
              const handles = await this.channel.sendMessage(chatId, state.textBuffer, {
                ...plainOpts,
                replyToMessageId: turnState.replyToMessageId ?? undefined,
              });
              state.textHandle = handles[0];
            }
          } else {
            const handles = await this.channel.sendMessage(chatId, state.textBuffer, {
              ...plainOpts,
              replyToMessageId: turnState.replyToMessageId ?? undefined,
            });
            state.textHandle = handles[0];
          }
          break;
        }

        case "tool_use": {
          // Flush streaming text — final edit with markdown formatting
          if (state.textHandle && state.textBuffer) {
            try {
              await this.channel.editMessage(chatId, state.textHandle, state.textBuffer);
            } catch { /* best effort */ }
          }
          state.textHandle = null;
          state.textBuffer = "";

          // In assistant behavior, all tool status is suppressed (no rolling status, no plan mode notifications)
          if (behavior === "assistant") break;

          // Relay behavior: existing display logic
          const { tool } = event;
          if (tool.toolName === "TodoWrite") {
            const text = formatTodoList(tool as Record<string, unknown>);
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

          if (tool.toolName === "EnterPlanMode") {
            await this.channel.sendMessage(chatId, "📋 Planning");
            break;
          }

          if (displayHandledTools.has(tool.toolName)) break;

          const line = formatToolStatusLine(tool);
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

        case "done":
          // Handled inline in executeTurn (task vs workspace need different session storage)
          break;

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

    // Task tools — only available during task turns
    if (this.tasks.has(chatId)) {
      tools.push(
        tool("workspace_create", "Create a new workspace and link it to the current chat", {
          name: z.string().describe("Workspace name (unique, e.g. 'myproject')"),
          cwd: z.string().describe("Absolute path to the workspace directory"),
          behavior: z.enum(["assistant", "relay"]).optional()
            .describe("Workspace behavior mode"),
          engine: z.string().optional()
            .describe("Engine to use (e.g. 'claude-code', 'kiro'). Defaults to the server's configured default engine."),
          spin_out_id: z.string().optional()
            .describe("Pending spin-out id to claim: after creation, its brief is delivered to this workspace as a peer message from the originating workspace"),
        }, async (args) => {
          if (this.config.workspaceByName(args.name)) {
            throw new Error(`Workspace "${args.name}" already exists. Choose a different name.`);
          }
          if (args.engine && !this.engines.has(args.engine)) {
            throw new Error(`Unknown engine "${args.engine}". Available: ${[...this.engines.keys()].join(", ")}`);
          }
          fs.mkdirSync(args.cwd, { recursive: true });
          this.config.upsertWorkspace({
            name: args.name,
            cwd: args.cwd,
            chat_id: chatId,
            current_session_id: null,
            behavior: args.behavior,
            engine: args.engine,
          });
          log.info("[tool] workspace_create: %s → %s engine=%s (chat %s)", args.name, args.cwd, args.engine ?? "default", chatId);
          if (args.spin_out_id) {
            const pending = this.config.listSpinOuts().find((s) => s.id === args.spin_out_id);
            if (!pending) {
              return { content: [{ type: "text" as const, text: `Workspace "${args.name}" created, but no pending spin-out "${args.spin_out_id}" was found.` }] };
            }
            this.config.removeSpinOut(pending.id);
            this.deliverToWorkspace(args.name, { kind: "peer", workspaceName: pending.fromWorkspace }, pending.brief);
            log.info("[tool] workspace_create: claimed spin-out %s from %s", pending.id, pending.fromWorkspace);
            return { content: [{ type: "text" as const, text: `Workspace "${args.name}" created at ${args.cwd}, linked to this chat. Spin-out brief from ${pending.fromWorkspace} will arrive after task_complete — call it now.` }] };
          }
          return { content: [{ type: "text" as const, text: `Workspace "${args.name}" created at ${args.cwd}, linked to this chat.` }] };
        }),
        tool("task_complete", "Signal that the current task is complete", {
          message: z.string().optional().describe("Summary of what was accomplished"),
        }, async (args) => {
          this.tasks.delete(chatId);
          log.info("[tool] task_complete: chat %s — %s", chatId, args.message ?? "done");
          return { content: [{ type: "text" as const, text: "Task completed." }] };
        }),
      );
    }

    // Scheduler tools — available in workspace turns (not task turns)
    if (!this.tasks.has(chatId) && this.scheduler) {
      const sched = this.scheduler;
      tools.push(
        tool("schedule_create", "Create a scheduled prompt. Accepts a cron expression for recurring, or an ISO timestamp for one-off (auto-deleted after firing). For timestamps, check current time first to ensure correctness.", {
          cron: z.string().describe("Cron expression (e.g. '0 9 * * *') or ISO timestamp (e.g. '2026-05-03T15:00:00') for one-off. Check current time before setting timestamps."),
          prompt: z.string().describe("The prompt text to run on schedule"),
          timezone: z.string().optional().describe("IANA timezone (e.g. 'America/Los_Angeles'). Defaults to system timezone"),
        }, async (args) => {
          const entry: ScheduleEntry = {
            id: crypto.randomUUID().slice(0, 8),
            cron: args.cron,
            prompt: args.prompt,
            enabled: true,
            timezone: args.timezone,
            createdAt: Date.now(),
          };
          sched.add(entry);
          const isDate = !isNaN(new Date(args.cron).getTime());
          return { content: [{ type: "text" as const, text: `Schedule "${entry.id}" created: ${args.cron}${args.timezone ? ` (${args.timezone})` : ""}${isDate ? " [one-off]" : ""}` }] };
        }),
        tool("schedule_list", "List all scheduled prompts", {}, async () => {
          const entries = sched.list();
          if (entries.length === 0) {
            return { content: [{ type: "text" as const, text: "No schedules configured." }] };
          }
          const lines = entries.map((e) =>
            `• ${e.id} — ${e.enabled ? "✓" : "✗"} ${e.cron}${e.timezone ? ` (${e.timezone})` : ""}\n  ${e.prompt.slice(0, 80)}`,
          );
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }),
        tool("schedule_delete", "Delete a scheduled prompt", {
          id: z.string().describe("Schedule ID to delete"),
        }, async (args) => {
          sched.remove(args.id);
          return { content: [{ type: "text" as const, text: `Schedule "${args.id}" deleted.` }] };
        }),
        tool("schedule_toggle", "Enable or disable a scheduled prompt", {
          id: z.string().describe("Schedule ID to toggle"),
          enabled: z.boolean().describe("Whether to enable or disable the schedule"),
        }, async (args) => {
          sched.toggle(args.id, args.enabled);
          return { content: [{ type: "text" as const, text: `Schedule "${args.id}" ${args.enabled ? "enabled" : "disabled"}.` }] };
        }),
      );
    }

    // Cross-workspace handoff — available in workspace turns (not task turns), independent of the scheduler
    if (!this.tasks.has(chatId)) {
      const self = this.config.workspaceByChat(chatId);
      const peers = this.config.listWorkspaces().filter((w) => w.name !== self?.name);
      const peerList = peers.length ? peers.map((w) => `"${w.name}"`).join(", ") : "(none)";
      tools.push(
        tool(
          "message_peer",
          `Send a message to another of your workspaces. It is delivered as a turn there and rendered in that chat; it can reply by calling message_peer back. Reachable workspaces: ${peerList}.`,
          {
            workspace: z.string().describe("Target workspace name (one of the reachable workspaces)"),
            message: z.string().describe("The message to send"),
          },
          async (args) => {
            const target = this.config.workspaceByName(args.workspace);
            if (!target) {
              return { content: [{ type: "text" as const, text: `No workspace named "${args.workspace}". Reachable: ${peerList}.` }] };
            }
            if (self && target.name === self.name) {
              return { content: [{ type: "text" as const, text: "Cannot message yourself." }] };
            }
            const fromName = self ? self.name : "unknown";
            const ok = this.deliverToWorkspace(target.name, { kind: "peer", workspaceName: fromName }, args.message);
            if (!ok) {
              return { content: [{ type: "text" as const, text: `Failed to deliver to "${target.name}".` }] };
            }
            await this.channel.sendMessage(chatId, `→ sent to ${target.name}: ${args.message}`);
            log.info("[tool] message_peer: %s → %s", fromName, target.name);
            return { content: [{ type: "text" as const, text: `Delivered to ${target.name}.` }] };
          },
        ),
        tool(
          "spin_out",
          "Propose splitting a related-but-separate strand of work into its own NEW workspace. Registers a pending brief; the user then creates a new group chat and adds the bot, and onboarding there offers to claim it. Write the brief as a distilled handoff: the goal plus the few specifics the new agent needs, not a context dump. (To hand a strand to an EXISTING workspace, use message_peer instead.)",
          {
            name: z.string().describe("Suggested workspace name (short, e.g. 'myapp-perf')"),
            brief: z.string().describe("Distilled brief delivered to the new workspace as its first message"),
            cwd: z.string().optional().describe("Suggested working directory, if known"),
          },
          async (args) => {
            const entry: PendingSpinOut = {
              id: crypto.randomUUID().slice(0, 8),
              fromWorkspace: self?.name ?? "unknown",
              name: args.name,
              brief: args.brief,
              suggestedCwd: args.cwd,
              createdAt: Date.now(),
            };
            this.config.addSpinOut(entry);
            await this.channel.sendMessage(chatId, `🌱 Spin-out "${args.name}" registered (${entry.id}). Create a new group, add me to it, and I'll offer to pick this up there.`);
            log.info("[tool] spin_out: %s registered from %s", entry.id, entry.fromWorkspace);
            return { content: [{ type: "text" as const, text: `Spin-out ${entry.id} registered. The user creates a new group chat and adds the bot; onboarding there claims the brief.` }] };
          },
        ),
        tool(
          "spin_out_cancel",
          "Cancel a pending spin-out that has not been claimed yet.",
          { id: z.string().describe("Pending spin-out id") },
          async (args) => {
            const removed = this.config.removeSpinOut(args.id);
            return { content: [{ type: "text" as const, text: removed ? `Spin-out ${args.id} cancelled.` : `No pending spin-out "${args.id}".` }] };
          },
        ),
      );
    }

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
    tool: ToolCall,
    chatId: string,
  ): Promise<{ decision: "allow" | "deny"; message?: string; updatedInput?: Record<string, unknown> }> {
    // Always auto-allow ClearClaw's own MCP tools
    if (tool.toolName.startsWith("mcp__clearclaw__")) {
      log.info(`[perm] ${tool.toolName} → auto-allow`);
      return { decision: "allow" };
    }

    log.info(`[perm] ${tool.toolName}`);

    // Custom tool handler (Claude Code specific tools like EnterPlanMode)
    const handler = permissionHandlers.get(tool.toolName);
    if (handler) {
      const result = handler(tool as Record<string, unknown>);
      if (result === null) {
        log.info(`[perm] ${tool.toolName} → auto-allow (handler)`);
        await this.channel.sendMessage(chatId, "📋 Entering plan mode");
        return { decision: "allow" };
      }
      try {
        const resp = await this.channel.sendInteractive(chatId, result.text, result.buttons);
        log.info(`[perm] ${tool.toolName} → ${resp.value || "timeout"}${resp.text ? ` "${resp.text}"` : ""}`);
        return result.mapResponse(resp);
      } catch (err) {
        log.warn({ err }, "[perm] failed to send prompt for %s, auto-denying", tool.toolName);
        return { decision: "deny" as const, message: "Permission prompt could not be delivered to chat — denied automatically." };
      }
    }

    try {
      const resp = await this.channel.sendInteractive(
        chatId,
        formatPermissionPrompt(tool),
        [
          [{ label: "👍 Allow", value: "allow" }, { label: "👎 Deny", value: "deny" }],
          [{ label: "📝 Deny + Note", value: "deny", requestText: true }],
        ],
      );
      log.info(`[perm] ${tool.toolName} → ${resp.value || "timeout"}${resp.text ? ` "${resp.text}"` : ""}`);
      return { decision: resp.value === "allow" ? "allow" : "deny", message: resp.text };
    } catch (err) {
      log.warn({ err }, "[perm] failed to send prompt for %s, auto-denying", tool.toolName);
      return { decision: "deny" as const, message: "Permission prompt could not be delivered to chat — denied automatically." };
    }
  }

  private async updateStatusMessage(chatId: string, state: ChatState): Promise<void> {
    const mode = state.permissionMode ?? this.config.permissionMode;
    const modeLabel = MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode;

    let text: string;
    if (state.stats) {
      const pct = state.stats.contextWindow > 0
        ? Math.round((state.stats.contextUsed / state.stats.contextWindow) * 100)
        : 0;
      const displayName = state.stats.model
        ? formatModelName(state.stats.model)
        : state.engineName ?? "agent";
      text = `🤖 ${displayName} ${pct}% | 🔒 ${modeLabel}`;
    } else {
      text = `🔒 ${modeLabel}`;
    }

    if (text === state.lastStatusText) return;
    await this.channel.updateStatus(chatId, text);
    state.lastStatusText = text;
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
function formatTimestamp(): string {
  const now = new Date();
  const day = now.toLocaleDateString("en-US", { weekday: "short" });
  const date = now.toLocaleDateString("en-CA"); // YYYY-MM-DD
  const time = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });
  return `${date} ${day} ${time}`;
}

function senderLabel(origin: MessageOrigin): string {
  switch (origin.kind) {
    case "user": return `[user] ${origin.user.handle ? `${origin.user.name} (@${origin.user.handle})` : origin.user.name}`;
    case "scheduler": return `[scheduler] ${origin.scheduleId}`;
    case "peer": return `[peer] ${origin.workspaceName}`;
    default: { const _exhaustive: never = origin; return _exhaustive; }
  }
}

function buildPrompt(messages: InboundMessage[]): string {
  const ts = formatTimestamp();
  return messages.map((msg) => {
    const sender = senderLabel(msg.origin);
    const msgIdPrefix = msg.messageId ? `[msg:${msg.messageId}] ` : "";
    const replyLine = formatReplyLine(msg.replyTo);
    return `${replyLine}[${ts}] ${msgIdPrefix}${sender}: ${msg.text}`;
  }).join("\n");
}

