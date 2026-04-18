import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import log from "../logger.js";
import { AsyncQueue } from "./async-queue.js";
import type { SpawnConfig } from "./registry.js";
import type {
  Engine,
  EngineEvent,
  PermissionMode,
  RunTurnOpts,
  SessionInfo,
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
      permissionMode,
      onPermissionRequest,
      signal,
    } = opts;

    let proc: ChildProcess | undefined;
    const queue = new AsyncQueue<EngineEvent>();
    const toolCalls: Record<string, number> = {};

    try {
      proc = spawnAgent(this.spawnConfig);

      // Log stderr for debugging
      proc.stderr?.on("data", (chunk: Buffer) => {
        log.debug("[acp:%s] %s", this.name, chunk.toString().trim());
      });

      // If the process dies unexpectedly, close the queue
      proc.on("exit", (code) => {
        log.info("[acp:%s] process exited with code %d", this.name, code ?? -1);
        queue.close();
      });

      // Build Client — sessionUpdate pushes to queue after session setup
      let live = false;

      const client: Client = {
        requestPermission: async (
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> => {
          return handlePermission(params, permissionMode, onPermissionRequest);
        },

        sessionUpdate: async (notification: SessionNotification): Promise<void> => {
          if (!live) return; // Suppress replay events from loadSession
          const event = mapSessionUpdate(notification, toolCalls);
          if (event) queue.push(event);
        },
      };

      // Create ACP connection over ndjson stdio
      const stream = ndJsonStream(
        Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
      );
      const conn = new ClientSideConnection((_agent) => client, stream);

      // Initialize
      await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "clearclaw", version: "0.4.0" },
        clientCapabilities: {},
      });

      // Create or resume session
      let acpSessionId: string;
      if (sessionId) {
        await conn.loadSession({ sessionId, cwd, mcpServers: [] });
        acpSessionId = sessionId;
      } else {
        const newSession = await conn.newSession({ cwd, mcpServers: [] });
        acpSessionId = newSession.sessionId;
      }

      // Now start accepting live events
      live = true;

      // Wire cancellation
      const onAbort = () => {
        conn.cancel({ sessionId: acpSessionId }).catch(() => {});
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      // Send prompt — resolves when turn completes
      const promptResponse = conn.prompt({
        sessionId: acpSessionId,
        prompt: [{ type: "text", text: textPrompt }],
      });

      // When prompt completes, push done event and close queue
      promptResponse
        .then(() => {
          queue.push({
            type: "done",
            sessionId: acpSessionId,
            stats: { model: null, contextUsed: 0, contextWindow: 0, toolCalls },
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

      // Cleanup
      signal?.removeEventListener("abort", onAbort);
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) {
        yield {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
      queue.close();
    } finally {
      if (proc && !proc.killed) {
        proc.kill();
      }
    }
  }

  async listSessions(_cwd: string): Promise<SessionInfo[]> {
    // Fast follow: spawn agent process and call conn.listSessions()
    return [];
  }
}

// --- Helpers ---

function spawnAgent(config: SpawnConfig): ChildProcess {
  const proc = spawn(config.command, config.args, {
    stdio: ["pipe", "pipe", "pipe"],
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
      return {
        type: "tool_use",
        toolName: update.title,
        input: (update.rawInput as Record<string, unknown>) ?? {},
        toolUseId: update.toolCallId,
      };
    }

    default:
      return null;
  }
}

async function handlePermission(
  params: RequestPermissionRequest,
  permissionMode: PermissionMode,
  onPermissionRequest: RunTurnOpts["onPermissionRequest"],
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

  // Relay to ClearClaw's permission flow
  const toolCall = params.toolCall;
  const resp = await onPermissionRequest({
    toolName: toolCall.title ?? "Unknown tool",
    input: (toolCall.rawInput as Record<string, unknown>) ?? {},
    description: toolCall.title ?? "Permission requested",
    toolUseId: toolCall.toolCallId,
  });

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
