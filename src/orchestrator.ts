import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import log from "./logger.js";
import { saveFile } from "./files.js";
import { assemblePrompt } from "./prompt.js";
import { formatPlanUsage, recordPlanUsage } from "./plan-usage.js";

import { formatToolStatusLine, formatToolCallSummary, formatPermissionPrompt, formatTodoList, timeAgo } from "./format.js";
import { permissionHandlers, displayHandledTools } from "./tool-handlers.js";
import { formatSessionTranscript } from "./engine/session-transcript.js";
import { Scheduler } from "./scheduler.js";
import type { Config, Project, ScheduleEntry } from "./config.js";
import type {
  Channel,
  Engine,
  EngineEvent,
  EngineHandoff,
  InboundMessage,
  MessageOrigin,
  PermissionMode,
  PlanUsageState,
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
  private creatingWorkspaces = new Set<string>();
  private scheduler: Scheduler | null = null;
  private planUsage = new Map<string, PlanUsageState>();

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
    this.config.ensureHomeWorkspace();
    this.channel.on("message", (msg) => {
      this.routeMessage(msg).catch((err) => {
        log.error({ err }, "[orchestrator] unhandled message error");
      });
    });

    await this.channel.connect();
    for (const ws of this.config.listWorkspaces()) this.deliverInitialBrief(ws.name);
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
    if (!ws?.chat_id || !this.channel.ownsId(ws.chat_id)) {
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

  /**
   * Everything creation can reject without touching the platform. Runs before the
   * confirmation, so the user is never asked to approve a doomed spawn, and again
   * inside creation, where it is the authoritative check.
   */
  private validateNewWorkspace(
    args: { name: string; cwd: string },
    newProjectName: string | undefined,
  ): string | null {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(args.name)) {
      return "Use a short workspace name containing letters, numbers, hyphens, or underscores.";
    }
    if (this.config.workspaceByName(args.name) || this.creatingWorkspaces.has(args.name)) {
      return `Workspace "${args.name}" already exists or is being created. Pick another name.`;
    }
    if (newProjectName && this.config.projectByName(newProjectName)) {
      return `Project "${newProjectName}" already exists. Name it as project to put this peer in it.`;
    }
    if (!path.isAbsolute(args.cwd) || !fs.existsSync(args.cwd) || !fs.statSync(args.cwd).isDirectory()) {
      return `cwd "${args.cwd}" must be an existing directory with an absolute path. Prepare it with your own tooling, then retry.`;
    }
    return null;
  }

  /** Shared creation path for standalone projects and peers, with optional manual binding. */
  private async createWorkspace(
    chatId: string,
    fromName: string,
    project: Project | undefined,
    newProjectName: string | undefined,
    mainWs: Workspace,
    args: { name: string; brief: string; description?: string; cwd: string;
      manual?: boolean; behavior?: "assistant" | "relay" },
    runtime: { engine?: string; model?: string },
  ) {
    const result = (text: string) => ({ content: [{ type: "text" as const, text }] });
    const invalid = this.validateNewWorkspace(args, newProjectName);
    if (invalid) return result(invalid);
    const description = args.description ?? args.brief.split("\n")[0].slice(0, 160);
    const destination = project ?? { name: newProjectName!, main_workspace: args.name, description };
    const anchor = mainWs.chat_id ?? chatId;
    if (!args.manual && (!this.channel.ownsId(anchor) || !this.channel.createProjectChat || !this.channel.closeProjectChat)) {
      return result("Automatic chat creation is unavailable for this destination. Retry with a manual chat, then use /connect <workspace> in that chat.");
    }
    this.creatingWorkspaces.add(args.name);
    const cwd = args.cwd;
    let createdChatId: string | null = null;
    let registered = false;
    let createdProject = false;
    try {
      if (!args.manual) createdChatId = await this.channel.createProjectChat!(destination.name, anchor, args.name);
      // Chat creation awaits the platform. Recheck config before committing our records.
      if (this.config.workspaceByName(args.name) || (newProjectName && this.config.projectByName(newProjectName))) {
        throw new Error("The workspace or project name was taken during chat creation. Retry with another name.");
      }
      if (createdChatId && this.config.workspaceByChat(createdChatId)) throw new Error("The created chat is already connected to another workspace.");
      if (project && !this.config.projectByName(project.name)) throw new Error("The target project was archived during chat creation.");
      this.config.upsertWorkspace({
        name: args.name, cwd, chat_id: createdChatId, current_session_id: null,
        behavior: args.behavior ?? mainWs.behavior, engine: runtime.engine, model: runtime.model,
        project: destination.name, description, spawnedFrom: fromName,
        pending_brief: { fromWorkspace: fromName, text: args.brief },
      });
      registered = true;
      if (!project) {
        this.config.addProject(destination);
        createdProject = true;
      }
    } catch (err) {
      if (createdProject) this.config.removeProject(destination.name);
      if (registered) this.config.removeWorkspace(args.name);
      if (createdChatId && !this.config.workspaceByChat(createdChatId)) {
        await this.channel.closeProjectChat!(createdChatId, destination.name).catch(() => {});
      }
      return result(`Spawn failed: ${err instanceof Error ? err.message : String(err)}. Retry with a manual chat if automatic chat creation is unavailable.`);
    } finally {
      this.creatingWorkspaces.delete(args.name);
    }
    // Once registered, notification failures must not roll back a workspace or a delivered brief.
    if (!project && createdChatId) {
      await this.channel.setupProject?.(destination.name, createdChatId).catch((err) => log.warn({ err }, "[project] optional setup failed"));
    }
    const delivered = this.deliverInitialBrief(args.name);
    const note = createdChatId
      ? (delivered ? "; brief delivered." : ".")
      : `. In the intended chat, send /connect ${args.name}.`;
    log.info("[workspace] created %s in %s", args.name, destination.name);
    return result(`Spawned workspace "${args.name}" at ${cwd}${note}`);
  }

  private deliverInitialBrief(name: string): boolean {
    const ws = this.config.workspaceByName(name);
    if (!ws?.chat_id || !ws.pending_brief) return false;
    // An existing or queued ordinary turn already includes the saved brief.
    const state = this.chats.get(ws.chat_id);
    if (state?.busy || state?.messageQueue.length) return false;
    const brief = ws.pending_brief;
    return this.deliverToWorkspace(name, { kind: "peer", workspaceName: brief.fromWorkspace }, brief.text);
  }

  /** An unbound chat can connect without starting a temporary agent or sharing home's session. */
  private async connectWorkspace(msg: InboundMessage, name?: string): Promise<void> {
    const reply = (text: string) => this.channel.sendMessage(msg.chatId, text);
    if (!name) { await reply("Usage: /connect <workspace>. Create a workspace with a manual chat from home first."); return; }
    const existing = this.config.workspaceByChat(msg.chatId);
    if (existing) { await reply(`This chat is already connected to "${existing.name}".`); return; }
    const ws = this.config.workspaceByName(name);
    if (!ws) { await reply(`No workspace named "${name}". Create it from home with a manual chat first.`); return; }
    if (name === "default") { await reply("Home connects automatically through an authorized private DM."); return; }
    if (ws.chat_id) { await reply(`Workspace "${name}" already has a chat. Existing bindings cannot be replaced by /connect.`); return; }
    if (this.chat(msg.chatId).busy) { await reply("A turn is running. Wait for it to finish before connecting."); return; }
    this.config.upsertWorkspace({ ...ws, chat_id: msg.chatId });
    if (ws.project && this.config.projectByName(ws.project)?.main_workspace === ws.name) {
      await this.channel.setupProject?.(ws.project, msg.chatId).catch((err) => log.warn({ err }, "[project] optional setup failed"));
    }
    this.deliverInitialBrief(name);
    await reply(`Connected this chat to workspace "${name}".`);
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
    return {
      runtime: {
        engine,
        model: requested.model
          ?? (effectiveEngine === baseEngine
            ? baseWorkspace?.model
            : undefined),
      },
    };
  }

  /** Effective behavior: Explicit setting or home→assistant / project→relay. */
  private effectiveBehavior(ctx: Workspace): "assistant" | "relay" {
    if (ctx.behavior !== undefined) return ctx.behavior;
    return ctx.cwd === this.config.homeWorkspacePath ? "assistant" : "relay";
  }

  /** Enqueue a message and drain — immediately for relay, debounced for assistant. */
  private enqueueMessage(msg: InboundMessage, ctx: Workspace, state: ChatState): void {
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

    const ctx: Workspace | undefined =
      this.config.workspaceByChat(chatId);
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
    ctx: Workspace,
    state: ChatState,
  ): Promise<void> {
    const ws = ctx;
    const initialBrief = slashCommandPrompt(messages) ? undefined : ws.pending_brief;
    if (initialBrief && !messages.some((m) => m.origin.kind === "peer"
      && m.origin.workspaceName === initialBrief.fromWorkspace && m.text === initialBrief.text)) {
      messages = [{ chatId, chatType: "group", origin: { kind: "peer", workspaceName: initialBrief.fromWorkspace }, text: initialBrief.text }, ...messages];
    }

    const turnCwd = ws.cwd;
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
    const sessionId = ws.current_session_id;
    const cwd = ws.cwd;
    const logPrefix = "[turn]";

    log.info("%s start session=%s msgs=%d cwd=%s", logPrefix, sessionId ?? "new", messages.length, cwd);
    await this.channel.setTyping(chatId, true);

    const { prompt: assembledPrompt, skipped } = await assemblePrompt(
      this.config.frameworkPromptDir,
      this.config.instructionsDir,
    );
    if (skipped.length > 0) {
      // Loud on purpose: running without instructions changes how the agent
      // behaves, so never let it look like a normal turn.
      await this.channel.sendMessage(chatId,
        `⚠️ Running without ${skipped.join(", ")} — unreadable (cloud placeholder or I/O timeout).`,
      ).catch(() => {});
    }
    const appendSystemPrompt = assembledPrompt;

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

    const engine = this.engineFor(ws);
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
        if (event.type === "plan_usage") {
          let usage = this.planUsage.get(engine.name);
          if (!usage) {
            usage = { windows: new Map(engine.planUsageWindows?.map((window) => [window.id, window])) };
            this.planUsage.set(engine.name, usage);
          }
          recordPlanUsage(usage, event);
          continue;
        }
        if (event.type === "error") turnFailed = true;
        // Persist the session as soon as the engine reports it —
        // so cancelling mid-turn doesn't lose it.
        if (event.type === "session") {
          this.persistSessionId(ws, event.sessionId);
          continue;
        }
        // Persist completion only while the workspace still belongs to this turn.
        if (event.type === "done") {
          log.info("%s done session=%s", logPrefix, event.sessionId);
          // Observed model/usage belongs in stats, never in the model override.
          const persistedSessionId = this.persistSessionId(ws, event.sessionId);
          if (persistedSessionId !== undefined && event.stats) state.stats = event.stats;
          if (initialBrief && persistedSessionId !== undefined && !turnFailed && !abort.signal.aborted) {
            const current = this.config.workspaceByName(ws.name);
            if (current?.pending_brief?.text === initialBrief.text
              && current.pending_brief.fromWorkspace === initialBrief.fromWorkspace) {
              this.config.upsertWorkspace({ ...current, pending_brief: undefined });
            }
          }
          if (handoff && persistedSessionId !== undefined && !turnFailed && !abort.signal.aborted) {
            const current = this.config.workspaceByName(ws.name);
            if (current && sameHandoff(current.engine_handoff, handoff)) {
              this.config.upsertWorkspace({ ...current, engine_handoff: undefined });
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
      if (cancelled) {
        await this.channel.sendMessage(chatId, "Turn cancelled.");
      }
    }
  }

  private persistSessionId(ws: Workspace, sessionId: string): string | undefined {
    const current = this.config.workspaceByName(ws.name);
    // Ignore late events after an archive, rebind, or engine switch.
    if (!current || current.chat_id !== ws.chat_id
      || (current.engine ?? this.config.defaultEngine) !== (ws.engine ?? this.config.defaultEngine)) return undefined;
    this.config.setSession(ws.name, sessionId);
    return sessionId;
  }

  /** Native selection works even when the workspace's engine cannot run. */
  private async selectEngine(msg: InboundMessage, requested?: string): Promise<void> {
    const state = this.chat(msg.chatId);
    const ws = this.config.workspaceByChat(msg.chatId);
    if (!ws) {
      await this.channel.sendMessage(msg.chatId, "No workspace linked to this chat. Use /connect <workspace> first.");
      return;
    }
    if (state.busy) {
      await this.channel.sendMessage(msg.chatId, "A turn is running. Use /cancel first, then /engine once it stops.");
      return;
    }
    const current = ws.engine ?? this.config.defaultEngine;
    const selected = requested ?? (await this.channel.sendInteractive(
      msg.chatId, `Current engine: ${current}`,
      [[...this.engines.keys()].map((name) => ({ label: name === current ? `✓ ${name}` : name, value: name }))],
    )).value;
    if (!selected) return;
    if (!this.engines.has(selected)) {
      await this.channel.sendMessage(msg.chatId, `Unknown engine "${selected}". Available: ${[...this.engines.keys()].join(", ")}`);
      return;
    }
    if (state.busy) {
      await this.channel.sendMessage(msg.chatId, "A turn is running. Use /cancel first, then /engine once it stops.");
      return;
    }
    const latest = this.config.workspaceByChat(msg.chatId);
    if (!latest || latest.name !== ws.name || (latest.engine ?? this.config.defaultEngine) !== current) {
      await this.channel.sendMessage(msg.chatId, "Workspace or engine changed while choosing. Run /engine again.");
      return;
    }
    const changed = selected !== current;
    if (changed) {
      this.config.upsertWorkspace({ ...latest, engine: selected, current_session_id: null, model: undefined,
        engine_handoff: captureHandoff(latest, current) });
      state.stats = null;
    }
    state.engineName = selected;
    const handoffNote = this.config.workspaceByChat(msg.chatId)?.engine_handoff
      ? " Previous session context will be included with your next message." : "";
    log.info("[cmd] chat %s engine → %s", msg.chatId, selected);
    await this.channel.sendMessage(msg.chatId, `Engine set to ${selected}.${changed ? " Session cleared." : ""}${handoffNote}`);
    await this.updateStatusMessage(msg.chatId, state);
  }

  private async routeMessage(msg: InboundMessage): Promise<void> {
    try {
      // routeMessage only handles channel-emitted messages, which are always user-originated.
      if (msg.origin.kind !== "user") return; // unreachable; documents + type-narrows the invariant
      const { user } = msg.origin;
      if (!this.config.isAuthorized(user.id)) return;
      if (this.channel.isRootDM(msg.chatId, user.id) && !this.config.workspaceByChat(msg.chatId)) {
        this.config.connectHomeWorkspace(msg.chatId);
      }
      const connect = msg.text.match(/^\/connect(?:\s+(\S+))?$/);
      if (connect) {
        await this.connectWorkspace(msg, connect[1]);
        return;
      }

      const state = this.chat(msg.chatId);

      // Native controls run without a model call.
      if (msg.text === "/cancel") {
        if (state.abort) {
          state.abort.abort();
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
        log.info("[cmd] session cleared for workspace %s", ws.name);
        await this.channel.sendMessage(msg.chatId, "Session cleared.");
        await this.updateStatusMessage(msg.chatId, state);
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

      // /engine [name] — select the workspace engine.
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
            ws.model ? `Saved model: ${ws.model}` : "No model override set. New sessions use the engine's default.",
          );
          return;
        }
        if (requested === "default") {
          this.config.setModel(ws.name, undefined);
          await this.channel.sendMessage(msg.chatId,
            "Model override cleared. Your current session is kept; use /new to start with the engine's default.");
          log.info("[cmd] workspace %s model override cleared", ws.name);
          return;
        }
        this.config.setModel(ws.name, requested);
        await this.channel.sendMessage(msg.chatId, `Model set to ${requested} for the next turn.`);
        log.info("[cmd] workspace %s model → %s", ws.name, requested);
        return;
      }

      if (!ws) {
        await this.channel.sendMessage(msg.chatId,
          "No workspace linked to this chat. Create a workspace with a manual chat from home or another workspace, then send /connect <workspace> here.");
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

        case "plan_usage":
          break; // Captured account-wide in executeTurn.

        case "done":
          // Handled inline in executeTurn for session persistence.
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

    // Scheduled prompts run in normal workspace sessions.
    if (this.scheduler) {
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

    // Workspace tools are available in every workspace conversation.
    if (this.config.workspaceByChat(chatId)) {
      const self = this.config.workspaceByChat(chatId);
      const peers = this.config.listWorkspaces().filter((w) => w.name !== self?.name);
      const projectNames = this.config.listProjects().map((p) => `"${p.name}"`).join(", ") || "(none)";
      tools.push(
        tool(
          "list_workspaces",
          "List workspaces with their project, focus, and whether a chat is connected. Covers every project by default; pass project to scope it. Use this to find a name for message_workspace.",
          {
            project: z.string().optional().describe("Only list workspaces in this project; omit for all projects"),
          },
          async (args) => {
            const all = this.config.listWorkspaces();
            const listed = args.project ? all.filter((w) => w.project === args.project) : all;
            if (listed.length === 0) {
              const known = this.config.listProjects().map((p) => p.name).join(", ") || "(none)";
              return { content: [{ type: "text" as const, text: args.project
                ? `No workspaces in project "${args.project}". Known projects: ${known}.`
                : "No workspaces." }] };
            }
            const lines = listed
              .map((w) => [
                w.name === self?.name ? `${w.name} (you)` : w.name,
                `project: ${w.project ?? "(none)"}`,
                w.chat_id ? "connected" : "awaiting /connect",
                w.description ? `— ${w.description}` : "",
              ].filter(Boolean).join(" | "))
              .sort();
            return { content: [{ type: "text" as const, text: lines.join("\n") }] };
          },
        ),
        tool(
          "message_workspace",
          "Send a message to another workspace, in any project. It is delivered as a turn there and rendered in that chat; it can reply by calling message_workspace back. Use list_workspaces to find a name.",
          {
            workspace: z.string().describe("Target workspace name; see list_workspaces"),
            message: z.string().describe("The message to send"),
          },
          async (args) => {
            const target = this.config.workspaceByName(args.workspace);
            if (!target) {
              return { content: [{ type: "text" as const, text: `No workspace named "${args.workspace}". Call list_workspaces to see the ${peers.length} reachable.` }] };
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
            log.info("[tool] message_workspace: %s → %s", fromName, target.name);
            return { content: [{ type: "text" as const, text: `Delivered to ${target.name}.` }] };
          },
        ),
        tool(
          "project_create",
          `Create a Project around an existing workspace so it can host peers. A workspace that is a peer of another Project is adopted out of it; one that is its Project's main cannot be (reassign that main first). Defaults to the current workspace. Existing Projects: ${projectNames}.`,
          {
            name: z.string().describe("New Project name"),
            description: z.string().describe("What the Project is about"),
            main_workspace: z.string().optional().describe("Existing workspace to make the Project main; must not be another Project's main. Defaults to the current workspace"),
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
            // A peer can be adopted out of its project; its main cannot — that would orphan the project.
            const currentProject = this.config.listProjects().find((p) => p.main_workspace === main.name);
            if (currentProject) {
              return { content: [{ type: "text" as const, text: `Workspace "${main.name}" already belongs to project "${currentProject.name}" as its main. Reassign that project's main via project_update first, or archive it.` }] };
            }
            this.config.upsertWorkspace({ ...main, project: args.name });
            this.config.addProject({
              name: args.name,
              description: args.description,
              main_workspace: main.name,
            });
            if (main.chat_id) await this.channel.setupProject?.(args.name, main.chat_id).catch((err) =>
              log.warn({ err }, "[project] platform setup failed for %s", args.name));
            log.info("[tool] project_create: %s (main %s)", args.name, main.name);
            return { content: [{ type: "text" as const, text: `Project "${args.name}" created with "${main.name}" as its main workspace.` }] };
          },
        ),
        tool("workspace_create", `Hand a strand of work to a NEW peer agent with its own chat, directory, and conversation. The peer joins your own project by default. Pass project to put it somewhere else: name an existing project to join it, or any new name to start that project with this peer as its main. Known projects: ${projectNames}. Prepare cwd yourself first — create a git worktree, clone, or plain directory the way this host and repository expect, and keep owning it; ClearClaw only reads the path and never creates or deletes it. The brief is the peer's first message: goal, decisions already made, and scope, leaving unstated implementation choices open. For an existing workspace use message_workspace instead.`, {
          name: z.string().min(1).describe("Unique short workspace name"),
          cwd: z.string().min(1).describe("Absolute path to a directory you have already prepared"),
          brief: z.string().min(1).describe("Goal, agreed decisions, and scope; delivered as the peer's first message"),
          description: z.string().optional().describe("One-line focus; defaults to the first 160 characters of the brief's first line"),
          project: z.string().optional().describe("Existing project to join, or a new project name to create with this peer as its main; defaults to your own project"),
          behavior: z.enum(["assistant", "relay"]).optional(),
          engine: z.string().optional(),
          model: z.string().optional(),
        }, async (args) => {
          const currentSelf = this.config.workspaceByChat(chatId);
          if (!currentSelf) return { content: [{ type: "text" as const, text: "The source workspace is no longer connected." }] };
          // An unknown name creates that project; a legacy caller with none falls back to the workspace name.
          const requested = args.project ?? currentSelf.project;
          const project = requested ? this.config.projectByName(requested) : undefined;
          const newProjectName = project ? undefined : requested ?? args.name;
          const base = project ? this.config.workspaceByName(project.main_workspace) : currentSelf;
          if (!base) return { content: [{ type: "text" as const, text: `Project "${project!.name}" has no main workspace.` }] };
          const resolved = this.peerRuntime(base, args);
          if (resolved.error) return { content: [{ type: "text" as const, text: resolved.error }] };
          const invalid = this.validateNewWorkspace(args, newProjectName);
          if (invalid) return { content: [{ type: "text" as const, text: invalid }] };
          const runtime = resolved.runtime!;
          const automatic = !!(this.channel.createProjectChat && this.channel.closeProjectChat
            && (!base.chat_id || this.channel.ownsId(base.chat_id)));
          const destination = project ? `project "${project.name}"` : `new project "${newProjectName}"`;
          const response = await this.channel.sendInteractive(chatId,
            `Create workspace "${args.name}" at ${args.cwd} in ${destination} using ${runtime.engine ?? this.config.defaultEngine}${runtime.model ? ` / ${runtime.model}` : ""}?\n\n${args.brief.slice(0, 300)}${automatic ? "" : "\nAutomatic chat creation is unavailable for this destination."}`,
            [[...(automatic ? [{ label: "Create chat", value: "spawn" }] : []),
              { label: "Manual chat", value: "manual" }, { label: "Cancel", value: "cancel" }]],
          );
          if (response.value !== "spawn" && response.value !== "manual") return { content: [{ type: "text" as const, text: "Workspace creation cancelled." }] };
          return this.createWorkspace(chatId, currentSelf.name, project, newProjectName, base, { ...args, manual: response.value === "manual" }, runtime);
        }),
        tool("workspace_archive", "Archive a workspace: try to close its bound chat, then unbind it even if chat closure fails. Reports any closure error. Always leaves the workspace directory on disk; clean that up with your own tooling. Cannot archive 'default'.", {
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
            `Archive workspace "${args.name}" (${target.cwd})? Its registration will be removed even if closing its chat fails. Its directory is left in place.`,
            [[{ label: "Archive", value: "yes" }, { label: "Cancel", value: "no" }]],
          );
          if (resp.value !== "yes") {
            return { content: [{ type: "text" as const, text: "Archive cancelled by the user." }] };
          }
          if (target.chat_id && (!this.channel.ownsId(target.chat_id) || !this.channel.closeProjectChat)) {
            return { content: [{ type: "text" as const, text: "Cannot archive: this channel cannot close the workspace's chat." }] };
          }
          // Whole Telegram chats and deleted topics can be impossible to close.
          let archiveNote = "";
          try {
            if (target.chat_id) await this.channel.closeProjectChat!(target.chat_id, target.project);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            log.warn("[tool] workspace_archive: chat closure failed, unbinding anyway: %s", reason);
            archiveNote = ` Chat closure failed (${reason}).`;
          }
          this.config.removeWorkspace(args.name);
          const removedProject = project?.main_workspace === args.name ? project : undefined;
          if (removedProject) this.config.removeProject(removedProject.name);
          archiveNote += " Its directory is left in place; clean up with your own tooling.";
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
          if (args.main_workspace && this.config.workspaceByName(args.main_workspace)?.project !== proj.name) {
            return { content: [{ type: "text" as const, text: `Choose a main workspace that already belongs to project "${proj.name}".` }] };
          }
          this.config.addProject({
            name: proj.name,
            description: args.description ?? proj.description,
            main_workspace: args.main_workspace ?? proj.main_workspace,
          });
          log.info("[tool] project_update: %s", args.name);
          return { content: [{ type: "text" as const, text: `Project "${args.name}" updated.` }] };
        }),
        tool("workspace_update", "Update what a workspace is working on (its description). Use /engine and /behavior in that workspace's chat to change runtime settings.", {
          name: z.string().describe("Workspace to update"),
          description: z.string().optional().describe("What this workspace is currently working on"),
        }, async (args) => {
          const ws = this.config.workspaceByName(args.name);
          if (!ws) {
            return { content: [{ type: "text" as const, text: `No workspace named "${args.name}".` }] };
          }
          this.config.upsertWorkspace({
            ...ws,
            description: args.description ?? ws.description,
          });
          log.info("[tool] workspace_update: %s", args.name);
          return { content: [{ type: "text" as const, text: `Workspace "${args.name}" updated.` }] };
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
      const usage = state.stats.contextWindow > 0
        ? `${Math.round((state.stats.contextUsed / state.stats.contextWindow) * 100)}%`
        : "usage n/a";
      const displayName = state.stats.modelLabel ?? state.stats.model ?? state.engineName ?? "agent";
      text = `🤖 ${displayName} ${usage}`;
    } else {
      text = "";
    }

    if (mode !== this.config.permissionMode) text += `${text ? " | " : ""}🔒 ${modeLabel}`;

    const ws = this.config.workspaceByChat(chatId);
    const engine = ws?.engine ?? state.engineName ?? this.config.defaultEngine;
    const maxLength = this.channel.statusMaxLength ?? 4096;
    if (text.length > maxLength - 80) text = `${text.slice(0, maxLength - 81)}…`;
    const usage = this.planUsage.get(engine) ?? {
      windows: new Map(this.engines.get(engine)?.planUsageWindows?.map((window) => [window.id, window])),
    };
    const separator = text ? " | " : "";
    text += separator + formatPlanUsage(usage, maxLength - text.length - separator.length);

    if (text === state.lastStatusText) return;
    try {
      await this.channel.updateStatus(chatId, text);
      state.lastStatusText = text;
    } catch (err) {
      log.warn({ err }, "[status] failed to update status for chat %s", chatId);
    }
  }
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
function captureHandoff(ctx: Workspace, engine: string): EngineHandoff | undefined {
  const sessionId = ctx.current_session_id;
  return ctx.engine_handoff ?? (sessionId ? { engine, sessionId, cwd: ctx.cwd } : undefined);
}

function sameHandoff(left: EngineHandoff | undefined, right: EngineHandoff): boolean {
  return left?.engine === right.engine && left.sessionId === right.sessionId && left.cwd === right.cwd;
}
