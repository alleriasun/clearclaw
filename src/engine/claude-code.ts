import {
  query,
  type SDKAssistantMessage,
  type SDKRateLimitEvent,
  type SDKResultMessage,
  type SDKLocalCommandOutputMessage,
  type SDKUserMessage,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import log from "../logger.js";
import { formatToolDescription } from "../format.js";
import type {
  Engine,
  EngineEvent,
  RunTurnOpts,
} from "../types.js";

export class ClaudeCodeEngine implements Engine {
  name = "claude-code";

  async *runTurn(opts: RunTurnOpts): AsyncIterable<EngineEvent> {
    const {
      sessionId,
      cwd,
      prompt,
      permissionMode,
      onPermissionRequest,
      signal,
    } = opts;

    const abortController = new AbortController();

    // Wire external signal to our abort controller
    if (signal) {
      signal.addEventListener("abort", () => abortController.abort(), {
        once: true,
      });
    }

    const sessionOpts: Record<string, unknown> = sessionId
      ? { resume: sessionId }
      : {};

    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        signal: AbortSignal;
        decisionReason?: string;
        toolUseID: string;
      },
    ): Promise<PermissionResult> => {
      const description = formatToolDescription(toolName, input);
      const resp = await onPermissionRequest({
        toolName,
        input,
        description,
        reason: options.decisionReason,
      });
      if (resp.decision === "allow") {
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: "User denied" };
    };

    const q = query({
      prompt,
      options: {
        ...sessionOpts,
        cwd,
        permissionMode,
        allowDangerouslySkipPermissions:
          permissionMode === "bypassPermissions" ? true : undefined,
        canUseTool,
        abortController,
      },
    });

    let resultSessionId: string | undefined;
    const toolUseIdToName = new Map<string, string>();

    try {
      for await (const msg of q) {
        if (msg.type !== "assistant") {
          const sub = msg.type === "result" ? ` (${(msg as SDKResultMessage).subtype})` : "";
          log.info(`[sdk] ${msg.type}${sub}`);
        }

        // Extract text and tool_use from assistant messages
        if (msg.type === "assistant") {
          const { content } = (msg as SDKAssistantMessage).message;
          for (const block of content) {
            if (block.type === "text" && block.text) {
              yield { type: "text", text: block.text };
            }
            if (block.type === "tool_use") {
              toolUseIdToName.set(
                (block as unknown as { id: string }).id,
                block.name,
              );
              yield {
                type: "tool_use",
                toolName: block.name,
                input: block.input as Record<string, unknown>,
              };
            }
          }
        }

        // Extract tool results from user messages
        if (msg.type === "user") {
          const content = (msg as SDKUserMessage).message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as Record<string, unknown>;
              if (
                b.type === "tool_result" &&
                typeof b.tool_use_id === "string"
              ) {
                const toolName =
                  toolUseIdToName.get(b.tool_use_id) ?? "unknown";
                const output = extractToolResultText(b.content);
                if (output) {
                  yield { type: "tool_result" as const, toolName, output };
                }
                toolUseIdToName.delete(b.tool_use_id);
              }
            }
          }
        }

        // Relay rate limit events
        if (msg.type === "rate_limit_event") {
          const { rate_limit_info } = msg as SDKRateLimitEvent;
          if (rate_limit_info.status !== "allowed") {
            yield {
              type: "rate_limit",
              status: rate_limit_info.status,
              resetsAt: rate_limit_info.resetsAt,
            };
          }
        }

        // Relay local command output (e.g. /compact, /cost, /model)
        if (msg.type === "system" && (msg as SDKLocalCommandOutputMessage).subtype === "local_command_output") {
          const cmdOut = msg as SDKLocalCommandOutputMessage;
          if (cmdOut.content) {
            yield { type: "text", text: cmdOut.content };
          }
        }

        // Capture result
        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          resultSessionId = result.session_id;
          if (result.subtype !== "success" && result.errors.length) {
            yield { type: "error", message: result.errors.join("\n") };
          }
        }
      }
    } catch (err) {
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (resultSessionId) {
      yield { type: "done", sessionId: resultSessionId };
    }
  }
}

/** Pull plain text out of a tool_result content block. */
function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b: Record<string, unknown>) =>
          b.type === "text" && typeof b.text === "string",
      )
      .map((b: Record<string, unknown>) => b.text as string)
      .join("\n");
  }
  return "";
}
