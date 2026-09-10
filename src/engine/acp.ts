import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
  type SessionConfigOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ToolCallContent as AcpToolCallContent,
  type McpServer,
} from "@agentclientprotocol/sdk";
import log from "../logger.js";
import { AsyncQueue } from "./async-queue.js";
import { serveMcpOverHttp, type McpBridge } from "./mcp-http.js";
import type { SpawnConfig } from "./registry.js";
import type {
  Engine,
  EngineEvent,
  PermissionMode,
  RunTurnOpts,
  SessionInfo,
  SessionHistoryOpts,
  SessionMessage,
  ToolCall,
} from "../types.js";

export class AcpEngine implements Engine {
  constructor(
    public readonly name: string,
    private readonly spawnConfig: SpawnConfig,
  ) {}

  async *runTurn(opts: RunTurnOpts): AsyncIterable<EngineEvent> {
    const {
      sessionId,
      cwd,
      prompt: textPrompt,
      attachments,
      permissionMode,
      onPermissionRequest,
      signal,
    } = opts;

    let proc: ChildProcess | undefined;
    const bridges: McpBridge[] = [];
    const queue = new AsyncQueue<EngineEvent>();
    const toolCalls: Record<string, number> = {};
    let contextUsed = 0;
    let contextWindow = 0;
    // tool_call events carry content that requestPermission lacks — cache by ID
    const pendingTools = new Map<string, ToolCall>();
    // ACP 0.16 does not reject pending setup requests when the process exits.
    let stop!: (reason: Error) => void;
    const stopped = new Promise<never>((_resolve, reject) => { stop = reject; });
    void stopped.catch(() => {});
    let cancelSession: (() => void) | undefined;
    const onAbort = () => {
      cancelSession?.();
      stop(new DOMException("Turn cancelled", "AbortError"));
      queue.close();
    };

    try {
      signal?.throwIfAborted();
      signal?.addEventListener("abort", onAbort, { once: true });
      proc = spawnAgent(this.spawnConfig, opts);
      proc.once("error", stop);

      // Log stderr for debugging
      proc.stderr?.on("data", (chunk: Buffer) => {
        log.debug("[acp:%s] %s", this.name, chunk.toString().trim());
      });

      // If the process dies unexpectedly, close the queue
      proc.on("exit", (code) => {
        log.info("[acp:%s] process exited with code %d", this.name, code ?? -1);
        stop(new Error(`ACP process exited during session setup (${code ?? "signal"})`));
        queue.close();
      });

      // Build Client — sessionUpdate pushes to queue after session setup
      let live = false;

      const client: Client = {
        requestPermission: async (
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> => {
          return handlePermission(params, permissionMode, onPermissionRequest, pendingTools);
        },

        sessionUpdate: async (notification: SessionNotification): Promise<void> => {
          // Usage is session state, including updates sent during session loading.
          if (notification.update.sessionUpdate === "usage_update") {
            contextUsed = notification.update.used;
            contextWindow = notification.update.size;
            return;
          }
          if (!live) return; // Suppress replay events from loadSession
          const event = mapSessionUpdate(notification, toolCalls, pendingTools);
          if (event) queue.push(event);
        },
      };

      // Create ACP connection over ndjson stdio
      const stream = ndJsonStream(
        Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
      );
      const conn = new ClientSideConnection((_agent) => client, stream);

      // Initialize and read agent capabilities
      const initResponse = await Promise.race([conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "clearclaw", version: "0.4.0" },
        clientCapabilities: {},
      }), stopped]);
      const supportsImages = initResponse.agentCapabilities?.promptCapabilities?.image ?? false;

      // Hand the agent every server it advertises a transport for; skip the rest.
      const httpCapable = initResponse.agentCapabilities?.mcpCapabilities?.http ?? false;
      const mcpServers: McpServer[] = [];
      for (const [name, server] of Object.entries(opts.mcpServers ?? {})) {
        signal?.throwIfAborted();
        if (server.type === "sdk" || server.type === "http") {
          // ponytail: agents without HTTP MCP run toolless, as every ACP engine did before.
          if (!httpCapable) {
            log.warn("[acp:%s] skipping MCP server %s: agent does not support HTTP", this.name, name);
            continue;
          }
          if (server.type === "sdk") {
            const bridge = await serveMcpOverHttp(name, server);
            bridges.push(bridge);
            mcpServers.push(bridge.config);
          } else {
            mcpServers.push({ type: "http", name, url: server.url,
              headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })) });
          }
        } else if (server.type === "sse") {
          // ClearClaw never configures SSE; no reason to build a passthrough for it.
          log.warn("[acp:%s] skipping MCP server %s: SSE is not supported", this.name, name);
        } else {
          mcpServers.push({ name, command: server.command, args: server.args ?? [],
            env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })) });
        }
      }
      signal?.throwIfAborted();

      // Create or resume session
      let acpSessionId: string;
      let configOptions: SessionConfigOption[] | null | undefined;
      if (sessionId) {
        const loadedSession = await Promise.race([conn.loadSession({ sessionId, cwd, mcpServers }), stopped]);
        configOptions = loadedSession.configOptions;
        acpSessionId = sessionId;
      } else {
        const newSession = await Promise.race([conn.newSession({ cwd, mcpServers }), stopped]);
        acpSessionId = newSession.sessionId;
        configOptions = newSession.configOptions;
      }

      // Persist before model selection so a rejected selection doesn't lose the session.
      yield { type: "session", sessionId: acpSessionId };

      if (opts.model) {
        signal?.throwIfAborted();
        // Categories are optional; accept an advertised "model" ID as a fallback.
        const modelOption = configOptions?.find((option) => option.category === "model")
          ?? configOptions?.find((option) => option.id === "model" && !option.category);
        if (!modelOption) throw new Error(`${this.name} did not advertise a model selector`);
        await Promise.race([conn.setSessionConfigOption({
          sessionId: acpSessionId, configId: modelOption.id, value: opts.model,
        }), stopped]);
      }

      // Now start accepting live events
      live = true;

      // Wire cancellation
      cancelSession = () => {
        conn.cancel({ sessionId: acpSessionId }).catch(() => {});
      };
      signal?.throwIfAborted();

      // Build prompt content blocks: text + any image attachments
      const promptBlocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text: textPrompt },
      ];
      for (const att of attachments ?? []) {
        const name = att.filename ?? att.mimeType;
        const isImage = att.mimeType.startsWith("image/");

        if (isImage && supportsImages) {
          promptBlocks.push({ type: "image", data: att.buffer.toString("base64"), mimeType: att.mimeType });
          const label = att.savedAs
            ? `[Attachment: ${name} — saved to ${att.savedAs}. Content already included; do not re-read from disk.]`
            : `[Attachment: ${name}]`;
          promptBlocks.push({ type: "text", text: label });
        } else {
          // Content not included (unsupported format or agent lacks image support)
          const reason = isImage ? "agent does not support images" : "unsupported format";
          const label = att.savedAs
            ? `[Attachment: ${name} (${reason}) — saved to ${att.savedAs}]`
            : `[Attachment: ${name} (${reason})]`;
          promptBlocks.push({ type: "text", text: label });
        }
      }

      // Send prompt — resolves when turn completes
      const promptResponse = conn.prompt({
        sessionId: acpSessionId,
        prompt: promptBlocks,
      });

      // When prompt completes, push done event and close queue
      promptResponse
        .then(() => {
          queue.push({
            type: "done",
            sessionId: acpSessionId,
            stats: { model: null, contextUsed, contextWindow, toolCalls },
          });
          queue.close();
        })
        .catch((err) => {
          queue.push({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
          queue.close();
        });

      // Yield events as they arrive
      yield* queue;
    } catch (err) {
      if (!signal?.aborted && !(err instanceof Error && err.name === "AbortError")) {
        yield {
          type: "error",
          message: errorMessage(err),
        };
      }
      queue.close();
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (proc && !proc.killed) {
        proc.kill();
      }
      const closed = await Promise.allSettled(bridges.map((bridge) => bridge.close()));
      for (const result of closed) {
        if (result.status === "rejected") log.error({ err: result.reason }, "[mcp] failed to close turn transport");
      }
    }
  }

  async getSessionMessages(opts: SessionHistoryOpts): Promise<SessionMessage[]> {
    opts.signal?.throwIfAborted();
    const signal = AbortSignal.any([
      ...(opts.signal ? [opts.signal] : []),
      AbortSignal.timeout(30_000),
    ]);
    const proc = spawnAgent(this.spawnConfig, {
      ...opts,
      prompt: "",
      permissionMode: "default",
      onPermissionRequest: async () => ({ decision: "deny", message: "History loading cannot run tools" }),
    });
    const messages: SessionMessage[] = [];
    let previousId: string | null | undefined;
    let previousRole: SessionMessage["role"] | undefined;
    let rejectStopped!: (reason: unknown) => void;
    const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
    const onAbort = () => rejectStopped(signal.reason);
    const onError = (err: Error) => rejectStopped(err);
    const onExit = () => rejectStopped(new Error(`${this.name} exited while loading session history`));
    signal.addEventListener("abort", onAbort, { once: true });
    proc.once("error", onError);
    proc.once("exit", onExit);
    // Drain stderr so verbose adapters cannot block waiting for a full pipe.
    proc.stderr?.resume();
    const client: Client = {
      extNotification: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      sessionUpdate: async ({ sessionId, update }) => {
        if (sessionId !== opts.sessionId) return;
        if (update.sessionUpdate !== "user_message_chunk" && update.sessionUpdate !== "agent_message_chunk") {
          // A tool/thought between text chunks ends the adjacent text segment.
          previousRole = undefined;
          return;
        }
        const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant";
        if (update.content.type !== "text") {
          previousRole = undefined;
          previousId = undefined;
          return;
        }
        const last = messages.at(-1);
        // ACP message IDs preserve separate consecutive messages from the same role.
        // Older agents without IDs can only be normalized into adjacent role segments.
        if (last && previousRole === role && previousId === update.messageId) {
          last.text += update.content.text;
        } else {
          messages.push({ role, text: update.content.text });
        }
        previousId = update.messageId;
        previousRole = role;
      },
    };
    const conn = new ClientSideConnection(() => client, ndJsonStream(
      Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
    ));
    try {
      await Promise.race([stopped, (async () => {
        const init = await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
        if (!init.agentCapabilities?.loadSession) {
          throw new Error(`${this.name} does not support loading session history`);
        }
        await conn.loadSession({ sessionId: opts.sessionId, cwd: opts.cwd, mcpServers: [] });
      })()]);
      signal.throwIfAborted();
      return messages.filter((message) => message.text.length > 0);
    } catch (err) {
      if (err instanceof Error) throw err;
      const message = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
      throw new Error(message);
    } finally {
      signal.removeEventListener("abort", onAbort);
      proc.removeListener("error", onError);
      proc.removeListener("exit", onExit);
      proc.stdin?.end();
      proc.kill();
    }
  }

  async listSessions(_cwd: string): Promise<SessionInfo[]> {
    // Fast follow: spawn agent process and call conn.listSessions()
    return [];
  }
}

// --- Helpers ---

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message;
  return String(err);
}

function spawnAgent(config: SpawnConfig, opts: RunTurnOpts): ChildProcess {
  const extraEnv = typeof config.env === "function" ? config.env(opts) : config.env;
  const proc = spawn(config.command, config.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });

  proc.on("error", (err) => {
    log.error({ err }, "[acp] failed to spawn %s", config.command);
  });

  if (!proc.stdin || !proc.stdout) {
    throw new Error(`Failed to spawn ${config.command} — stdin/stdout not available`);
  }

  return proc;
}

function mapSessionUpdate(
  notification: SessionNotification,
  toolCalls: Record<string, number>,
  pendingTools: Map<string, ToolCall>,
): EngineEvent | null {
  const update = notification.update;

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = update.content;
      if (content.type === "text") {
        return { type: "text_chunk", text: content.text };
      }
      return null;
    }

    case "tool_call": {
      const kind = update.kind ?? "tool";
      toolCalls[kind] = (toolCalls[kind] ?? 0) + 1;
      const tool = acpToolCall(update.title, update.toolCallId, kind, update.locations, update.content);
      pendingTools.set(update.toolCallId, tool);
      return { type: "tool_use", tool };
    }

    case "tool_call_update":
      return null;

    default:
      return null;
  }
}

/** Map ACP tool call fields to ToolCall. */
function acpToolCall(
  title: string,
  toolCallId: string,
  kind: string,
  locations?: Array<{ path: string; line?: number | null }> | null,
  content?: Array<AcpToolCallContent> | null,
): ToolCall {
  const toolName = title;
  const toolUseId = toolCallId;
  const paths = locations?.map((l) => l.line ? `${l.path}:${l.line}` : l.path);

  switch (kind) {
    case "edit": {
      const diff = findDiff(content);
      return {
        action: "edit", toolName, toolUseId,
        path: diff?.path ?? paths?.[0] ?? "",
        before: diff?.oldText ?? "",
        after: diff?.newText ?? "",
      };
    }
    case "write": {
      const diff = findDiff(content);
      return {
        action: "write", toolName, toolUseId,
        path: diff?.path ?? paths?.[0] ?? "",
        content: diff?.newText ?? "",
      };
    }
    case "read":
      return { action: "read", toolName, toolUseId, paths: paths ?? [] };
    case "execute":
      return { action: "execute", toolName, toolUseId, command: title };
    case "search":
      return { action: "search", toolName, toolUseId, pattern: title, paths };
    case "fetch":
      return { action: "fetch", toolName, toolUseId, url: title };
    default: {
      const detail = findTextContent(content);
      return { action: kind, toolName, toolUseId, paths, detail };
    }
  }
}

/** Find the first diff content block from ACP tool call content. */
function findDiff(content?: Array<AcpToolCallContent> | null) {
  const entry = content?.find((c) => c.type === "diff");
  return entry?.type === "diff" ? entry : undefined;
}

/** Extract text from the first content block. */
function findTextContent(content?: Array<AcpToolCallContent> | null): string | undefined {
  const entry = content?.find((c) => c.type === "content");
  if (entry?.type === "content" && entry.content.type === "text") return entry.content.text;
  return undefined;
}

async function handlePermission(
  params: RequestPermissionRequest,
  permissionMode: PermissionMode,
  onPermissionRequest: RunTurnOpts["onPermissionRequest"],
  pendingTools: Map<string, ToolCall>,
): Promise<RequestPermissionResponse> {
  const allowOption = params.options.find((o) => o.kind === "allow_once");
  const rejectOption = params.options.find((o) => o.kind === "reject_once");

  // Auto-approve in bypass mode
  if (permissionMode === "bypassPermissions" || permissionMode === "dontAsk") {
    return {
      outcome: allowOption
        ? { outcome: "selected", optionId: allowOption.optionId }
        : { outcome: "cancelled" },
    };
  }

  // Use cached tool_call data (has content/locations) over the sparse permission request
  const toolCall = params.toolCall;
  const tool = pendingTools.get(toolCall.toolCallId)
    ?? acpToolCall(
      toolCall.title ?? "Unknown tool",
      toolCall.toolCallId,
      toolCall.kind ?? "other",
      toolCall.locations,
      toolCall.content,
    );
  const resp = await onPermissionRequest(tool);

  if (resp.decision === "allow" && allowOption) {
    return {
      outcome: { outcome: "selected", optionId: allowOption.optionId },
    };
  }

  if (rejectOption) {
    return {
      outcome: { outcome: "selected", optionId: rejectOption.optionId },
    };
  }

  return { outcome: { outcome: "cancelled" } };
}
