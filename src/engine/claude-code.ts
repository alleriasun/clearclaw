import {
  query,
  listSessions,
  type SDKAssistantMessage,
  type SDKRateLimitEvent,
  type SDKResultMessage,
  type SDKLocalCommandOutputMessage,
  type SDKUserMessage,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ContentBlockParam,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import log from "../logger.js";
import { formatToolDescription } from "../format.js";
import type {
  Attachment,
  Engine,
  EngineEvent,
  RunTurnOpts,
  SessionInfo,
  TurnStats,
} from "../types.js";

export class ClaudeCodeEngine implements Engine {
  name = "claude-code";

  async listSessions(cwd: string): Promise<SessionInfo[]> {
    const sessions = await listSessions({ dir: cwd, limit: 10 });
    return sessions
      .sort((a, b) => b.lastModified - a.lastModified)
      .map((s) => ({
        sessionId: s.sessionId,
        summary: s.summary,
        lastModified: s.lastModified,
        gitBranch: s.gitBranch,
      }));
  }

  async *runTurn(opts: RunTurnOpts): AsyncIterable<EngineEvent> {
    const {
      sessionId,
      cwd,
      prompt: textPrompt,
      attachments,
      permissionMode,
      onPermissionRequest,
      appendSystemPrompt,
      mcpServers,
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
        toolUseId: options.toolUseID,
      });
      if (resp.decision === "allow") {
        return { behavior: "allow", updatedInput: input };
      }
      const denyMessage = resp.message
        ? `User denied this action with feedback: ${resp.message}`
        : "User denied";
      // Deny with note: let the model read the feedback and adjust.
      // Plain deny: interrupt to stop the turn immediately.
      // (The SDK has a bug where interrupt causes an unhandled rejection —
      // handleControlRequest writes to stdin after the subprocess exits.
      // Suppressed by the unhandledRejection handler in index.ts.)
      return {
        behavior: "deny",
        message: denyMessage,
        interrupt: !resp.message,
      };
    };

    // Plain string when no attachments, content blocks when attachments present
    const prompt = attachments?.length
      ? buildAttachmentPrompt(textPrompt, attachments)
      : textPrompt;

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
        settingSources: ["user", "project", "local"],
        ...(mcpServers ? { mcpServers } : {}),
        ...(appendSystemPrompt
          ? {
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: appendSystemPrompt,
              },
            }
          : {}),
      },
    });

    let resultSessionId: string | undefined;
    let turnStats: TurnStats | undefined;
    let lastInputTokens = 0;
    const toolUseIdToName = new Map<string, string>();

    try {
      for await (const msg of q) {
        if (msg.type !== "assistant") {
          const sub = msg.type === "result" ? ` (${(msg as SDKResultMessage).subtype})` : "";
          log.info(`[sdk] ${msg.type}${sub}`);
        }

        // Extract text and tool_use from assistant messages
        if (msg.type === "assistant") {
          // BetaMessage type isn't directly importable (@anthropic-ai/sdk not installed);
          // .message is typed as `any` so property access works without casting.
          const betaMsg = (msg as SDKAssistantMessage).message;
          if (betaMsg.usage) {
            const u = betaMsg.usage;
            lastInputTokens = (u.input_tokens ?? 0)
              + (u.cache_read_input_tokens ?? 0)
              + (u.cache_creation_input_tokens ?? 0);
          }
          const { content } = betaMsg;
          for (const block of content) {
            if (block.type === "text" && block.text) {
              yield { type: "text", text: block.text };
            }
            if (block.type === "tool_use") {
              const toolUseId = (block as unknown as { id: string }).id;
              toolUseIdToName.set(toolUseId, block.name);
              yield {
                type: "tool_use",
                toolName: block.name,
                input: block.input as Record<string, unknown>,
                toolUseId,
              };
            }
          }
        }

        // Extract tool results from user messages
        if (msg.type === "user") {
          const content = (msg as SDKUserMessage).message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") {
                const toolName =
                  toolUseIdToName.get(block.tool_use_id) ?? "unknown";
                const output = extractToolResultText(block.content);
                if (output) {
                  yield { type: "tool_result" as const, toolName, output };
                }
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

        // Capture result and build turn stats
        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          resultSessionId = result.session_id;

          const models = Object.keys(result.modelUsage);
          if (models.length > 0) {
            const model = models[0];
            const mu = result.modelUsage[model];
            // Build per-tool call counts from accumulated map
            const toolCalls: Record<string, number> = {};
            for (const name of toolUseIdToName.values()) {
              toolCalls[name] = (toolCalls[name] ?? 0) + 1;
            }
            turnStats = {
              model,
              contextUsed: lastInputTokens,
              contextWindow: mu.contextWindow,
              toolCalls,
            };
          }

          if (result.subtype !== "success" && result.errors.length) {
            yield { type: "error", message: result.errors.join("\n") };
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        log.info("[sdk] turn aborted");
      } else {
        yield {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (resultSessionId) {
      yield { type: "done", sessionId: resultSessionId, stats: turnStats };
    }
  }
}

/**
 * Build an AsyncIterable<SDKUserMessage> that yields a single user message
 * with content blocks for attachments + text.
 */
function buildAttachmentPrompt(
  text: string,
  attachments: Attachment[],
): AsyncIterable<SDKUserMessage> {
  const contentBlocks: ContentBlockParam[] = attachments.map(encodeAttachment);

  // Text prompt always comes last
  if (text) {
    contentBlocks.push({ type: "text", text });
  }

  const message: MessageParam = { role: "user", content: contentBlocks };

  // SDKUserMessage requires these fields for type satisfaction, but they're
  // not semantically meaningful here — we're injecting a top-level prompt,
  // not replaying a conversation. Session management is handled by the
  // `resume` option passed to query().
  const msg: SDKUserMessage = {
    type: "user",
    message,
    parent_tool_use_id: null,
    session_id: "",
  };

  return (async function* () {
    yield msg;
  })();
}

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
]);

/** Encode an attachment as an SDK content block using its in-memory buffer. */
function encodeAttachment(att: Attachment): ContentBlockParam {
  const data = att.buffer.toString("base64");

  if (SUPPORTED_IMAGE_TYPES.has(att.mimeType)) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: att.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        data,
      },
    };
  }

  if (att.mimeType === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data },
    };
  }

  if (att.mimeType.startsWith("text/")) {
    const content = att.buffer.toString("utf-8");
    const header = att.filename ? `--- ${att.filename} ---\n` : "";
    return { type: "text", text: `${header}${content}` };
  }

  // Unsupported (includes non-standard image types like svg, bmp, tiff)
  const name = att.filename ?? att.mimeType;
  log.warn("[engine] unsupported attachment type: %s", att.mimeType);
  return { type: "text", text: `[Unsupported file: ${name}]` };
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
