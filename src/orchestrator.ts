import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import log from "./logger.js";
import { saveFile } from "./files.js";
import { assemblePrompt } from "./prompt.js";
import { repoRootOf, createWorktree, removeWorktree } from "./worktree.js";
import { formatToolStatusLine, formatToolCallSummary, formatPermissionPrompt, formatTodoList, timeAgo } from "./format.js";
import { permissionHandlers, displayHandledTools } from "./tool-handlers.js";
import { formatSessionTranscript } from "./engine/session-transcript.js";
import { Scheduler } from "./scheduler.js";
import type { Config, PendingSpinOut, Project, ScheduleEntry } from "./config.js";
import type {
  Channel,
  Engine,
  EngineEvent,
  EngineHandoff,
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
  textPublishedLength: number;
  textReplySent: boolean;
  engineName: string | null; // engine name for status display when model is null
  // Per-chat message queue: relay drains immediately, assistant debounces
  messageQueue: InboundMessage[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

interface TaskState {
  engine?: string;
  engine_handoff?: EngineHandoff;
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

const STREAM_EDIT_LIMIT = 3000;
const STREAM_INITIAL_EDIT_MIN = 96;
const STREAM_EDIT_DELTA = 160;

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
        textPublishedLength: 0,
        textReplySent: false,
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

  /** Spawn a peer workspace into a project: worktree (if the project's repo is git) + a new chat + brief delivery. Best-effort rollback on failure. */
  private async spawnPeer(
    chatId: string,
    fromName: string,
    project: Project,
    mainWs: Workspace,
    args: { name: string; brief: string; cwd?: string; branch?: string },
    runtime: { engine?: string; model?: string },
  ) {
    const channel = this.channel;
    if (!channel.createProjectChat || !channel.closeProjectChat) {
      throw new Error("Channel does not support peer chat creation and closure");
    }
    if (this.config.workspaceByName(args.name)) {
      return { content: [{ type: "text" as const, text: `Workspace "${args.name}" already exists. Pick another name.` }] };
    }
    const hasExplicitCwd = args.cwd !== undefined;
    if (hasExplicitCwd && (!fs.existsSync(args.cwd!) || !fs.statSync(args.cwd!).isDirectory())) {
      return {
        content: [{
          type: "text" as const,
          text: `Spawn failed: explicit cwd "${args.cwd}" must be an existing directory. ClearClaw will not create it; prepare it with your own tooling, then retry.`,
        }],
      };
    }
    let cwd = args.cwd;
    let ownsWorktree: boolean | undefined = hasExplicitCwd ? false : undefined;
    let createdChatId: string | undefined;
    try {
      if (!cwd) {
        const repoRoot = repoRootOf(mainWs.cwd);
        if (repoRoot) {
          cwd = createWorktree(repoRoot, args.name, undefined, args.branch);
          ownsWorktree = true;
        } else {
          cwd = mainWs.cwd;
        }
      }
      createdChatId = await channel.createProjectChat(project.name, mainWs.chat_id, args.name);
      this.config.upsertWorkspace({
        name: args.name,
        cwd,
        chat_id: createdChatId,
        current_session_id: null,
        behavior: mainWs.behavior,
        engine: runtime.engine,
        model: runtime.model,
        project: project.name,
        description: args.brief,
        spawnedFrom: fromName,
        owns_worktree: ownsWorktree,
      });
      this.deliverToWorkspace(args.name, { kind: "peer", workspaceName: fromName }, args.brief);
      await this.channel.sendMessage(chatId, `🌱 Spawned "${args.name}" in ${project.name}.`);
      log.info("[tool] spin_out: spawned %s (cwd %s) in project %s", args.name, cwd, project.name);
      return { content: [{ type: "text" as const, text: `Spawned workspace "${args.name}" at ${cwd}; brief delivered.` }] };
    } catch (err) {
      // Best-effort rollback so a failed spawn leaves nothing behind.
      if (createdChatId) {
        await channel.closeProjectChat(createdChatId, project.name).catch(() => { /* best effort */ });
      }
      if (ownsWorktree && cwd) {
        try { removeWorktree(cwd); } catch { /* best effort */ }
      }
      const detail = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Spawn failed: ${detail}. You can retry with a different name, or register the brief for a manual group instead.` }] };
    }
  }

  /** Register a pending spin-out brief (1b fallback) for the user to claim by creating a new group. */
  private async registerSpinOutBrief(
    chatId: string,
    fromName: string,
    args: { name: string; brief: string; cwd?: string },
    fallbackReason: string,
    runtime: { engine?: string; model?: string },
  ) {
    const entry: PendingSpinOut = {
      id: crypto.randomUUID().slice(0, 8),
      fromWorkspace: fromName,
      name: args.name,
      brief: args.brief,
      suggestedCwd: args.cwd,
      engine: runtime.engine,
      model: runtime.model,
      createdAt: Date.now(),
    };
    this.config.addSpinOut(entry);
    const effectiveEngine = runtime.engine ?? this.config.defaultEngine;
    const runtimeLabel = runtime.model ? `${effectiveEngine} / ${runtime.model}` : effectiveEngine;
    log.info("[tool] spin_out: %s registered from %s using %s; pending-brief fallback because %s",
      entry.id, fromName, runtimeLabel, fallbackReason);
    await this.channel.sendMessage(chatId, `🌱 Spin-out "${args.name}" registered (${entry.id}) using ${runtimeLabel} because ${fallbackReason}. Create a new group, add me to it, and I'll offer to pick this up there.`);
    return { content: [{ type: "text" as const, text: `Spin-out ${entry.id} registered using ${runtimeLabel} because ${fallbackReason}. The user creates a new group chat and adds the bot; onboarding there claims the brief.` }] };
  }

  private peerRuntime(
    baseWorkspace: Workspace | undefined,
    requested: { engine?: string; model?: string },
  ): { runtime?: { engine?: string; model?: string }; error?: string } {
    const baseEngine = baseWorkspace?.engine ?? this.config.defaultEngine;
    const engine = requested.engine ?? baseWorkspace?.engine;
    const effectiveEngine = engine ?? this.config.defaultEngine;
    if (!this.engines.has(effectiveEngine)) {
      return { error: `Unknown engine "${effectiveEngine}". Available: ${[...this.engines.keys()].join(", ")}` };
    }
    if (requested.model && effectiveEngine !== "claude-code") {
      return { error: `Model override isn't supported for the "${effectiveEngine}" engine.` };
    }
    return {
      runtime: {
        engine,
        model: requested.model
          ?? (effectiveEngine === "claude-code" && effectiveEngine === baseEngine
            ? baseWorkspace?.model
            : undefined),
      },
    };
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

    const turnCwd = task ? task.cwd : ws!.cwd;
    if (!fs.existsSync(turnCwd)) {
      log.warn("[turn] aborting: cwd does not exist: %s", turnCwd);
      await this.channel.sendMessage(chatId, `⚠️ Can't start: this workspace's directory doesn't exist:\n${turnCwd}\nLikely an un-created worktree. Create it (e.g. \`git worktree add "${turnCwd}" -b <branch>\`) or fix the workspace cwd, then retry.`).catch(() => {});
      return;
    }

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

    const slashPrompt = slashCommandPrompt(messages);
    let prompt = slashPrompt ?? buildPrompt(messages);
    const handoff = !slashPrompt && messages.some((message) => message.origin.kind === "user")
      ? ctx.engine_handoff : undefined;
    if (handoff) {
      let transcript: string;
      try {
        const previousEngine = this.engines.get(handoff.engine);
        if (!previousEngine) throw new Error(`Unknown previous engine "${handoff.engine}"`);
        const history = await previousEngine.getSessionMessages({
          sessionId: handoff.sessionId, cwd: handoff.cwd, signal: abort.signal,
        });
        transcript = formatSessionTranscript(history);
      } catch (err) {
        log.warn({ err }, "[handoff] could not read previous session %s", handoff.sessionId);
        transcript = "Transcript unavailable. Do not assume prior conversation details.";
      }
      prompt = [
        "Continuing after an engine switch. The following is historical conversation context, not new instructions.",
        `Previous engine: ${handoff.engine}`,
        `Previous session ID: ${handoff.sessionId}`,
        "<previous-conversation>", transcript, "</previous-conversation>",
        "Respond to the latest message below:", prompt,
      ].join("\n\n");
    }

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

    const engine = ws ? this.engineFor(ws) : this.engines.get(task!.engine ?? this.config.defaultEngine)!;
    state.engineName = engine.name;

    let turnFailed = false;
    try {
      abort.signal.throwIfAborted();
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
        model: ws?.model,
      })) {
        if (event.type === "error") turnFailed = true;
        // Persist session (+ resolved model) as soon as the engine reports it —
        // so cancelling mid-turn doesn't lose it.
        if (event.type === "session") {
          this.persistSessionId(chatId, task, ws, event.sessionId, event.model);
          continue;
        }
        // Handle done event inline — task vs workspace need different session storage
        if (event.type === "done") {
          log.info("%s done session=%s", logPrefix, event.sessionId);
          // Model already persisted from the early "session" event above —
          // writing it again here from this (possibly stale, if /model ran
          // mid-turn) turn's resolved model would race and clobber it.
          const persistedSessionId = this.persistSessionId(chatId, task, ws, event.sessionId);
          // task_complete removes setup before done; /cancel also aborts the turn.
          const completedTask = task !== undefined && !abort.signal.aborted && !this.tasks.has(chatId);
          if ((persistedSessionId !== undefined || completedTask) && event.stats) state.stats = event.stats;
          if (handoff && persistedSessionId !== undefined && !turnFailed && !abort.signal.aborted) {
            if (task) {
              if (task.engine_handoff === handoff) delete task.engine_handoff;
            } else {
              const current = this.config.workspaceByName(ws!.name);
              if (current && sameHandoff(current.engine_handoff, handoff)) {
                this.config.upsertWorkspace({ ...current, engine_handoff: undefined });
              }
            }
          }
          if (behavior === "relay" && state.toolCallHandle && event.stats) {
            const summary = formatToolCallSummary(event.stats.toolCalls);
            if (summary) {
              try { await this.channel.editMessage(chatId, state.toolCallHandle, summary); } catch { /* */ }
            }
          }
          state.toolCallHandle = null;
          state.todoHandle = null;
          await this.flushTextSegment(chatId, state, turnState);
          state.textHandle = null;
          state.textBuffer = "";
          state.textPublishedLength = 0;
          state.textReplySent = false;
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

  /** Task turns keep the session ID in memory; workspace turns persist it (+ resolved model) to config. */
  private persistSessionId(
    chatId: string,
    task: TaskState | undefined,
    ws: Workspace | undefined,
    sessionId: string,
    model?: string,
  ): string | undefined {
    if (task) {
      if (this.tasks.get(chatId) !== task) return undefined;
      task.sessionId = sessionId;
    } else {
      const current = this.config.workspaceByName(ws!.name);
      // Ignore late events if the workspace engine changed during this turn.
      if (!current || (current.engine ?? this.config.defaultEngine) !== (ws!.engine ?? this.config.defaultEngine)) return undefined;
      this.config.setSession(ws!.name, sessionId, model);
    }
    return sessionId;
  }

  /** Create setup state without starting an engine turn. */
  private createOnboardingTask(msg: InboundMessage): TaskState {
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
        ...spinOuts.map((s) => `- ${s.id}: "${s.name}" from workspace ${s.fromWorkspace}${s.suggestedCwd ? `, suggested cwd ${s.suggestedCwd}` : ""}${s.engine ? `, engine ${s.engine}` : ""}${s.model ? `, model ${s.model}` : ""} — ${s.brief.slice(0, 200)}`),
      );
    }
    const newTask: TaskState = {
      sessionId: null,
      cwd: this.config.homeWorkspacePath,
      prompt: promptLines.join("\n"),
    };
    this.tasks.set(msg.chatId, newTask);
    log.info("[task] onboarding started for chat %s", msg.chatId);
    return newTask;
  }

  /** Native engine selection must remain available when setup's engine cannot run. */
  private async selectEngine(msg: InboundMessage, requested?: string): Promise<void> {
    const state = this.chat(msg.chatId);
    if (state.busy) {
      await this.channel.sendMessage(msg.chatId, "A turn is running. Use /cancel first, then /engine once it stops.");
      return;
    }
    const task = this.tasks.get(msg.chatId);
    const ws = this.config.workspaceByChat(msg.chatId);
    const current = task
      ? task.engine ?? this.config.defaultEngine
      : ws?.engine ?? this.config.defaultEngine;
    const selected = requested ?? (await this.channel.sendInteractive(
      msg.chatId,
      `Current engine: ${current}`,
      [[...this.engines.keys()].map((name) => ({ label: name === current ? `✓ ${name}` : name, value: name }))],
    )).value;
    if (!selected) return;
    if (!this.engines.has(selected)) {
      await this.channel.sendMessage(msg.chatId, `Unknown engine "${selected}". Available: ${[...this.engines.keys()].join(", ")}`);
      return;
    }
    // The picker awaits user input: a turn, /cancel, or workspace update may have intervened.
    if (state.busy) {
      await this.channel.sendMessage(msg.chatId, "A turn is running. Use /cancel first, then /engine once it stops.");
      return;
    }
    const latestTask = this.tasks.get(msg.chatId);
    const latestWs = this.config.workspaceByChat(msg.chatId);
    const latestEngine = latestTask
      ? latestTask.engine ?? this.config.defaultEngine
      : latestWs?.engine ?? this.config.defaultEngine;
    if (latestTask !== task || latestWs?.name !== ws?.name || latestEngine !== current) {
      await this.channel.sendMessage(msg.chatId, "Setup or engine changed while choosing. Run /engine again.");
      return;
    }
    const setup = latestTask ?? (!latestWs ? this.createOnboardingTask(msg) : undefined);
    const changed = selected !== current;
    if (setup) {
      setup.engine = selected;
      if (changed) {
        setup.engine_handoff = captureHandoff(setup, current);
        setup.sessionId = null;
      }
    }
    const workspaceChanged = latestWs && (latestWs.engine ?? this.config.defaultEngine) !== selected;
    if (workspaceChanged) {
      this.config.upsertWorkspace({
        ...latestWs, engine: selected, current_session_id: null, model: undefined,
        engine_handoff: captureHandoff(latestWs, latestWs.engine ?? this.config.defaultEngine),
      });
    }
    if (changed || workspaceChanged) state.stats = null;
    state.engineName = selected;
    await this.updateStatusMessage(msg.chatId, state);
    const pendingHandoff = setup?.engine_handoff ?? this.config.workspaceByChat(msg.chatId)?.engine_handoff;
    const handoffNote = pendingHandoff ? " Previous session context will be included with your next message." : "";
    log.info("[cmd] chat %s engine → %s", msg.chatId, selected);
    await this.channel.sendMessage(msg.chatId,
      `Engine set to ${selected}.${changed ? " Session cleared." : ""}${handoffNote}${setup ? " Send a message to continue setup." : ""}`);
  }

  private async routeMessage(msg: InboundMessage): Promise<void> {
    try {
      // routeMessage only handles channel-emitted messages, which are always user-originated.
      if (msg.origin.kind !== "user") return; // unreachable; documents + type-narrows the invariant
      const { user } = msg.origin;

      const state = this.chat(msg.chatId);

      // Native controls run before task/workspace dispatch, without a model call.
      // /cancel — abort running turn or clear active task
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
          await this.channel.interrupt?.(msg.chatId).catch((err) => {
            log.warn({ err }, "[cmd] channel interrupt failed for %s", msg.chatId);
          });
          log.info("[cmd] turn cancelled");
        } else {
          await this.channel.sendMessage(msg.chatId, "Nothing to cancel.");
        }
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
          const current = this.config.workspaceByName(ws.name);
          if (current) this.config.upsertWorkspace({ ...current, current_session_id: resp.value, engine_handoff: undefined });
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

      // /engine [name] — select an engine, including before/during setup.
      const engineMatch = msg.text.match(/^\/engine(?:\s+(\S+))?$/);
      if (engineMatch) {
        if (!this.config.isAuthorized(user.id)) {
          await this.channel.sendMessage(msg.chatId, "Not authorized to select an engine.");
          return;
        }
        await this.selectEngine(msg, engineMatch[1]);
        return;
      }

      // /model [name] — show or set the per-workspace model override
      const modelMatch = msg.text.match(/^\/model(?:\s+(\S+))?$/);
      if (modelMatch) {
        if (!ws) {
          await this.channel.sendMessage(msg.chatId, "No workspace linked to this chat.");
          return;
        }
        const requested = modelMatch[1];
        if (!requested) {
          await this.channel.sendMessage(
            msg.chatId,
            ws.model ? `Current model: ${ws.model}` : "No model override set — using the engine's default.",
          );
          return;
        }
        if (this.engineFor(ws).name !== "claude-code") {
          await this.channel.sendMessage(msg.chatId, `Model override isn't supported for the "${this.engineFor(ws).name}" engine.`);
          return;
        }
        this.config.setModel(ws.name, requested);
        await this.channel.sendMessage(msg.chatId, `Model set to ${requested}.`);
        log.info("[cmd] workspace %s model → %s", ws.name, requested);
        return;
      }

      // Only non-control messages reach the active task or workspace engine.
      const existingTask = this.tasks.get(msg.chatId);
      if (existingTask) {
        this.enqueueMessage(msg, existingTask, state);
        return;
      }

      if (!ws) {
        if (this.config.isAuthorized(user.id)) {
          const newTask = this.createOnboardingTask(msg);
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
          await this.routeTextChunk(chatId, event.text, state, turnState);
          break;
        }

        case "tool_use": {
          // Flush streaming text — final edit with markdown formatting
          await this.flushTextSegment(chatId, state, turnState);
          state.textHandle = null;
          state.textBuffer = "";
          state.textPublishedLength = 0;

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

  private async routeTextChunk(
    chatId: string,
    text: string,
    state: ChatState,
    turnState: { staySilent: boolean; replyToMessageId: string | null },
  ): Promise<void> {
    state.textBuffer += text;

    while (state.textBuffer.length > STREAM_EDIT_LIMIT) {
      const splitAt = streamSplitPoint(state.textBuffer, STREAM_EDIT_LIMIT);
      const segment = state.textBuffer.slice(0, splitAt);
      state.textBuffer = state.textBuffer.slice(
        state.textBuffer.charAt(splitAt) === "\n" ? splitAt + 1 : splitAt,
      );
      await this.publishTextSegment(chatId, segment, state, turnState, true);
      state.textHandle = null;
      state.textPublishedLength = 0;
    }

    if (
      state.textBuffer.length > 0
      && (
        state.textHandle
          ? state.textBuffer.length - state.textPublishedLength >= STREAM_EDIT_DELTA
          : state.textBuffer.length >= STREAM_INITIAL_EDIT_MIN
      )
    ) {
      await this.publishTextSegment(chatId, state.textBuffer, state, turnState, false);
    }
  }

  private async publishTextSegment(
    chatId: string,
    text: string,
    state: ChatState,
    turnState: { replyToMessageId: string | null },
    final: boolean,
  ): Promise<void> {
    const plainOpts = { format: "plain" as const };
    if (state.textHandle) {
      try {
        await this.channel.editMessage(chatId, state.textHandle, text, final ? undefined : plainOpts);
        state.textPublishedLength = text.length;
        return;
      } catch (err) {
        if (isUnchangedMessageError(err)) {
          state.textPublishedLength = text.length;
          return;
        }
        if (isTransientChannelError(err)) return;
        state.textHandle = null;
        state.textPublishedLength = 0;
      }
    }

    const handles = await this.channel.sendMessage(chatId, text, {
      ...(final ? {} : plainOpts),
      replyToMessageId: !state.textReplySent ? (turnState.replyToMessageId ?? undefined) : undefined,
    });
    state.textHandle = handles[0] ?? null;
    state.textPublishedLength = text.length;
    state.textReplySent = true;
  }

  private async flushTextSegment(
    chatId: string,
    state: ChatState,
    turnState: { replyToMessageId: string | null },
  ): Promise<void> {
    if (!state.textBuffer) return;
    if (!state.textHandle) {
      try {
        await this.publishTextSegment(chatId, state.textBuffer, state, turnState, true);
      } catch { /* best effort */ }
      return;
    }
    try {
      await this.channel.editMessage(chatId, state.textHandle, state.textBuffer);
      state.textPublishedLength = state.textBuffer.length;
    } catch { /* best effort */ }
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
        tool("workspace_create", "Create a new workspace and its project, and link it to the current chat. Every workspace belongs to a project; this creates the project with the new workspace as its main.", {
          name: z.string().describe("Workspace name (unique, e.g. 'myproject'); also used as the project name"),
          cwd: z.string().describe("Absolute path to the workspace directory"),
          description: z.string().describe("What this project is about — a short shared-context summary"),
          behavior: z.enum(["assistant", "relay"]).optional()
            .describe("Workspace behavior mode"),
          engine: z.string().optional()
            .describe("Engine to use (e.g. 'claude-code', 'kiro'). Defaults to the engine selected for setup, then the claimed spin-out engine, then the server default."),
          model: z.string().optional()
            .describe("Model override for Claude Code. When claiming a spin-out, defaults to its chosen model."),
          spin_out_id: z.string().optional()
            .describe("Pending spin-out id to claim: after creation, its brief is delivered to this workspace as a peer message from the originating workspace"),
        }, async (args) => {
          if (this.config.workspaceByName(args.name)) {
            throw new Error(`Workspace "${args.name}" already exists. Choose a different name.`);
          }
          const pending = args.spin_out_id
            ? this.config.listSpinOuts().find((candidate) => candidate.id === args.spin_out_id)
            : undefined;
          const engine = args.engine ?? this.tasks.get(chatId)?.engine ?? pending?.engine;
          const effectiveEngine = engine ?? this.config.defaultEngine;
          const pendingEngine = pending?.engine ?? this.config.defaultEngine;
          const model = args.model
            ?? (effectiveEngine === "claude-code" && effectiveEngine === pendingEngine
              ? pending?.model
              : undefined);
          if (!this.engines.has(effectiveEngine)) {
            throw new Error(`Unknown engine "${effectiveEngine}". Available: ${[...this.engines.keys()].join(", ")}`);
          }
          if (model && effectiveEngine !== "claude-code") {
            throw new Error(`Model override isn't supported for the "${effectiveEngine}" engine.`);
          }
          fs.mkdirSync(args.cwd, { recursive: true });
          this.config.upsertWorkspace({
            name: args.name,
            cwd: args.cwd,
            chat_id: chatId,
            current_session_id: null,
            behavior: args.behavior,
            engine,
            model,
            project: args.name,
            description: args.description,
          });
          this.config.addProject({ name: args.name, description: args.description, main_workspace: args.name });
          await this.channel.setupProject?.(args.name, chatId).catch((err) =>
            log.warn({ err }, "[project] platform setup failed for %s", args.name));
          log.info("[tool] workspace_create: %s → %s engine=%s model=%s (chat %s)",
            args.name, args.cwd, engine ?? "default", model ?? "default", chatId);
          if (args.spin_out_id) {
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
      const projectNames = this.config.listProjects().map((p) => `"${p.name}"`).join(", ") || "(none)";
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
          "project_create",
          `Create a Project around an existing workspace so it can become a spin_out target. The chosen main workspace must not already belong to another Project. Defaults to the current workspace. Existing Projects: ${projectNames}.`,
          {
            name: z.string().describe("New Project name"),
            description: z.string().describe("What the Project is about"),
            main_workspace: z.string().optional().describe("Existing unprojected workspace to make the Project main; defaults to the current workspace"),
          },
          async (args) => {
            if (this.config.projectByName(args.name)) {
              return { content: [{ type: "text" as const, text: `Project "${args.name}" already exists.` }] };
            }
            const mainName = args.main_workspace ?? self?.name;
            if (!mainName) {
              return { content: [{ type: "text" as const, text: "No current workspace to use as the Project main." }] };
            }
            const main = this.config.workspaceByName(mainName);
            if (!main) {
              return { content: [{ type: "text" as const, text: `No workspace named "${mainName}".` }] };
            }
            if (main.project) {
              return { content: [{ type: "text" as const, text: `Workspace "${main.name}" already belongs to project "${main.project}".` }] };
            }
            this.config.upsertWorkspace({ ...main, project: args.name });
            this.config.addProject({
              name: args.name,
              description: args.description,
              main_workspace: main.name,
            });
            await this.channel.setupProject?.(args.name, main.chat_id).catch((err) =>
              log.warn({ err }, "[project] platform setup failed for %s", args.name));
            log.info("[tool] project_create: %s (main %s)", args.name, main.name);
            return { content: [{ type: "text" as const, text: `Project "${args.name}" created with "${main.name}" as its main workspace.` }] };
          },
        ),
        tool(
          "spin_out",
          `Propose splitting a related-but-separate strand of work into its own NEW peer workspace. One-tap spawning is available when the target project resolves, its main workspace exists, and the channel supports Project chat lifecycle; otherwise this registers a pending brief the user claims by creating a group. The peer inherits its Project main's engine and model by default; pass engine and/or model to override them. Model overrides currently require the claude-code engine. Pass an existing cwd when external tooling prepared the worktree: the path must already exist, and ClearClaw will never create or remove it. Omit cwd to let ClearClaw create and own a standard git worktree for plain git repos. Defaults to your own project; pass "into" to spawn into another. Write the brief as a distilled handoff: convey the goal, the decisions the user has already made, and the scope, not the implementation. Leave schema, file layout, and approach for the receiving agent to design with the user; pass through detailed design only when the user has clearly specified it, never invent it. Known projects: ${projectNames}. (To hand a strand to an EXISTING workspace, use message_peer instead.)`,
          {
            name: z.string().describe("Suggested workspace name (short, e.g. 'myapp-perf')"),
            brief: z.string().describe("Distilled brief delivered to the new workspace as its first message"),
            cwd: z.string().min(1).optional().describe("Existing working directory prepared by the caller. It must already exist; ClearClaw never creates or removes an explicitly provided path. Omit to let ClearClaw create and manage a standard git worktree when possible."),
            branch: z.string().optional().describe("Git branch used only when ClearClaw creates the worktree (cwd omitted). Conventional name (e.g. 'feat/x', 'fix/y', 'chore/z'); defaults to 'feat/<name>'."),
            into: z.string().optional().describe("Target project name to spawn into; defaults to your own project"),
            engine: z.string().optional().describe("Engine for the peer (e.g. 'claude-code', 'kiro'); defaults to the Project main's engine"),
            model: z.string().optional().describe("Claude Code model override for the peer; defaults to the Project main's model when using the same engine"),
          },
          async (args) => {
            const currentSelf = this.config.workspaceByChat(chatId) ?? self;
            const fromName = currentSelf?.name ?? "unknown";
            const targetName = args.into ?? currentSelf?.project;
            const project = targetName ? this.config.projectByName(targetName) : undefined;
            const mainWs = project ? this.config.workspaceByName(project.main_workspace) : undefined;
            const resolved = this.peerRuntime(mainWs ?? currentSelf, args);
            if (resolved.error) {
              return { content: [{ type: "text" as const, text: resolved.error }] };
            }
            const runtime = resolved.runtime!;
            const effectiveEngine = runtime.engine ?? this.config.defaultEngine;
            const runtimeLabel = runtime.model ? `${effectiveEngine} / ${runtime.model}` : effectiveEngine;
            let fallbackReason: string;

            if (project && mainWs && this.channel.createProjectChat && this.channel.closeProjectChat) {
              const resp = await this.channel.sendInteractive(
                chatId,
                `🌱 Spin out "${args.name}" into ${project.name} using ${runtimeLabel}?\n\n${args.brief.slice(0, 300)}`,
                [[
                  { label: `Spawn in ${project.name}`, value: "spawn" },
                  { label: "Manual group", value: "manual" },
                  { label: "Cancel", value: "cancel" },
                ]],
              );
              if (resp.value === "cancel") {
                return { content: [{ type: "text" as const, text: "Spin-out cancelled by the user." }] };
              }
              if (resp.value === "spawn") {
                return this.spawnPeer(chatId, fromName, project, mainWs, args, runtime);
              }
              fallbackReason = resp.value === "manual"
                ? "the user selected a manual group"
                : "one-tap spawning was not selected";
            } else if (!project) {
              fallbackReason = args.into
                ? `no project "${args.into}" resolved for workspace "${fromName}"`
                : `no project resolved for workspace "${fromName}"`;
            } else if (!mainWs) {
              fallbackReason = `project "${project.name}" has no main workspace "${project.main_workspace}"`;
            } else {
              fallbackReason = `channel "${this.channel.name}" lacks peer chat creation or closure`;
            }
            return this.registerSpinOutBrief(chatId, fromName, args, fallbackReason, runtime);
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
        tool("workspace_archive", "Archive a workspace: close its bound chat and unbind it. Removes a git worktree only when ClearClaw created and owns it; externally managed worktrees stay in place. Cannot archive 'default'.", {
          name: z.string().describe("Workspace to archive"),
        }, async (args) => {
          if (args.name === "default") {
            return { content: [{ type: "text" as const, text: "Cannot archive the home workspace." }] };
          }
          const target = this.config.workspaceByName(args.name);
          if (!target) {
            return { content: [{ type: "text" as const, text: `No workspace named "${args.name}".` }] };
          }
          const project = target.project ? this.config.projectByName(target.project) : undefined;
          if (project?.main_workspace === args.name) {
            const peers = this.config.listWorkspaces().filter((w) => w.project === project.name && w.name !== args.name);
            if (peers.length > 0) {
              return { content: [{ type: "text" as const, text: `Cannot archive "${args.name}": it's the main of project "${project.name}", which still has peers (${peers.map((p) => `"${p.name}"`).join(", ")}). Archive those first, or reassign the main via project_update.` }] };
            }
          }
          const resp = await this.channel.sendInteractive(
            chatId,
            `Archive workspace "${args.name}" (${target.cwd}) and close its chat?`,
            [[{ label: "Archive", value: "yes" }, { label: "Cancel", value: "no" }]],
          );
          if (resp.value !== "yes") {
            return { content: [{ type: "text" as const, text: "Archive cancelled by the user." }] };
          }
          if (!this.channel.ownsId(target.chat_id) || !this.channel.closeProjectChat) {
            return { content: [{ type: "text" as const, text: "Cannot archive: this channel cannot close the workspace's chat." }] };
          }
          try {
            await this.channel.closeProjectChat(target.chat_id, target.project);
          } catch (err) {
            return { content: [{ type: "text" as const, text: `Cannot archive: chat closure failed (${err instanceof Error ? err.message : String(err)}). Workspace remains bound.` }] };
          }
          this.config.removeWorkspace(args.name);
          const removedProject = project?.main_workspace === args.name ? project : undefined;
          if (removedProject) this.config.removeProject(removedProject.name);
          let archiveNote = "";
          if (target.spawnedFrom) {
            if (target.owns_worktree === true) {
              try { removeWorktree(target.cwd); } catch (err) {
                log.warn("[tool] workspace_archive: worktree removal failed, leaving directory: %s", err instanceof Error ? err.message : String(err));
              }
            } else if (target.owns_worktree === false) {
              archiveNote = " External worktree left in place; clean up with your own tooling.";
            } else {
              archiveNote = " Workspace directory left in place because ClearClaw does not own it.";
            }
          }
          log.info("[tool] workspace_archive: %s", args.name);
          return { content: [{ type: "text" as const, text: `Workspace "${args.name}" archived.${archiveNote}` }] };
        }),
        tool("project_update", "Update a project's shared context: its description, or reassign its main workspace.", {
          name: z.string().describe("Project name to update"),
          description: z.string().optional().describe("New description (what the project is about)"),
          main_workspace: z.string().optional().describe("Reassign the project's main workspace"),
        }, async (args) => {
          const proj = this.config.projectByName(args.name);
          if (!proj) {
            return { content: [{ type: "text" as const, text: `No project named "${args.name}".` }] };
          }
          if (args.main_workspace && !this.config.workspaceByName(args.main_workspace)) {
            return { content: [{ type: "text" as const, text: `No workspace named "${args.main_workspace}".` }] };
          }
          this.config.addProject({
            name: proj.name,
            description: args.description ?? proj.description,
            main_workspace: args.main_workspace ?? proj.main_workspace,
          });
          log.info("[tool] project_update: %s", args.name);
          return { content: [{ type: "text" as const, text: `Project "${args.name}" updated.` }] };
        }),
        tool("workspace_update", "Update a workspace: what it's working on (its description), or its behavior/engine.", {
          name: z.string().describe("Workspace to update"),
          description: z.string().optional().describe("What this workspace is currently working on"),
          behavior: z.enum(["assistant", "relay"]).optional().describe("Workspace behavior mode"),
          engine: z.string().optional().describe("Engine (e.g. 'claude-code', 'kiro')"),
        }, async (args) => {
          const ws = this.config.workspaceByName(args.name);
          if (!ws) {
            return { content: [{ type: "text" as const, text: `No workspace named "${args.name}".` }] };
          }
          if (args.engine && !this.engines.has(args.engine)) {
            return { content: [{ type: "text" as const, text: `Unknown engine "${args.engine}". Available: ${[...this.engines.keys()].join(", ")}` }] };
          }
          // Switching engines must reset the session: a stored session id belongs to the old
          // engine and the new one can't resume it (codex can't load a claude session id).
          const engineChanged = args.engine !== undefined && args.engine !== (ws.engine ?? this.config.defaultEngine);
          this.config.upsertWorkspace({
            ...ws,
            description: args.description ?? ws.description,
            behavior: args.behavior ?? ws.behavior,
            engine: args.engine ?? ws.engine,
            current_session_id: engineChanged ? null : ws.current_session_id,
          });
          log.info("[tool] workspace_update: %s%s", args.name, engineChanged ? ` (engine → ${args.engine}, session reset)` : "");
          const resetNote = engineChanged ? ` Engine set to "${args.engine}"; session reset.` : "";
          return { content: [{ type: "text" as const, text: `Workspace "${args.name}" updated.${resetNote}` }] };
        }),
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

/**
 * A lone slash-command message (built-in like `/compact`, `/context`, or a
 * custom `.claude/commands/<name>`) must reach the engine verbatim: the CLI
 * only intercepts a slash command when it sits at position 0 of the prompt.
 * buildPrompt's `[ts] sender:` framing would push it off position 0, so the
 * command would be sent to the model as plain text instead of executed.
 *
 * ClearClaw's own commands (/new, /resume, /behavior, …) are handled and
 * returned before the turn starts, so any leading-slash message that reaches
 * here is a pass-through command. Restricted to single, user-typed messages —
 * a slash buried in a batch, or in a scheduler/peer prompt, is not a command.
 * Returns the bare command text, or null to fall back to buildPrompt.
 */
function slashCommandPrompt(messages: InboundMessage[]): string | null {
  if (messages.length !== 1) return null;
  const msg = messages[0];
  if (msg.origin.kind !== "user") return null;
  const text = msg.text.trim();
  return text.startsWith("/") ? text : null;
}

function streamSplitPoint(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const newlineAt = text.lastIndexOf("\n", limit);
  return newlineAt > 0 ? newlineAt : limit;
}

function isTransientChannelError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Too Many Requests") || message.includes("429:");
}

function isUnchangedMessageError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("message is not modified");
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

/** Preserve the original source across multiple switches before a handoff succeeds. */
function captureHandoff(ctx: TurnContext, engine: string): EngineHandoff | undefined {
  const sessionId = isTask(ctx) ? ctx.sessionId : ctx.current_session_id;
  return ctx.engine_handoff ?? (sessionId ? { engine, sessionId, cwd: ctx.cwd } : undefined);
}

function sameHandoff(left: EngineHandoff | undefined, right: EngineHandoff): boolean {
  return left?.engine === right.engine && left.sessionId === right.sessionId && left.cwd === right.cwd;
}
