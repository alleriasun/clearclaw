import {
  query,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKLocalCommandOutputMessage,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
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
      return { behavior: "deny", message: "User denied", interrupt: true };
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

    try {
      for await (const msg of q) {
        if (msg.type !== "assistant") {
          const sub = msg.type === "result" ? ` (${(msg as SDKResultMessage).subtype})` : "";
          console.log(`[sdk] ${msg.type}${sub}`);
        }

        // Extract text from assistant messages
        if (msg.type === "assistant") {
          const { content } = (msg as SDKAssistantMessage).message;
          for (const block of content) {
            if (block.type === "text" && block.text) {
              yield { type: "text", text: block.text };
            }
            if (block.type === "tool_use") {
              yield {
                type: "tool_use",
                toolName: block.name,
                input: block.input as Record<string, unknown>,
              };
            }
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
          if (result.subtype === "success") {
            resultSessionId = result.session_id;
          } else if (result.errors.length) {
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

function formatToolDescription(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "Bash":
      return `Bash: ${input.command ?? "(unknown command)"}`;
    case "Edit":
    case "Write":
    case "Read":
      return `${toolName}: ${input.file_path ?? "(unknown file)"}`;
    default:
      return `Allow ${toolName}?`;
  }
}
