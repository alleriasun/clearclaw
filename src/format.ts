/**
 * Diff formatting utilities for tool_use display in Telegram.
 *
 * Uses the `diff` library for proper unified diffs with context lines.
 */

import { createTwoFilesPatch } from "diff";

const MAX_LINES = 200;

// --- Tool input types ---

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

interface WriteInput {
  file_path: string;
  content: string;
}

/**
 * Format a tool_use event for display. Returns a MarkdownV2 string.
 * Edit/Write get rich formatting; all others get a one-line status.
 */
export function formatToolUse(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "Edit") {
    return formatEditDiff(input as unknown as EditInput);
  }
  if (toolName === "Write") {
    return formatWritePreview(input as unknown as WriteInput);
  }
  return escapeMarkdownV2(`🔧 ${formatToolStatus(toolName, input)}`);
}

function formatToolStatus(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "Bash":
      return `Bash: ${input.command ?? "(unknown)"}`;
    case "Read":
      return `Read: ${input.file_path ?? "(unknown)"}`;
    case "Glob":
      return `Glob: ${input.pattern ?? "(unknown)"}`;
    case "Grep":
      return `Grep: ${input.pattern ?? "(unknown)"}`;
    case "WebFetch":
      return `WebFetch: ${input.url ?? "(unknown)"}`;
    case "WebSearch":
      return `WebSearch: ${input.query ?? "(unknown)"}`;
    case "Agent":
      return `Agent: ${input.description ?? "(unknown)"}`;
    default:
      return toolName;
  }
}

function formatEditDiff(input: EditInput): string {
  const patch = createTwoFilesPatch(
    `a/${input.file_path}`,
    `b/${input.file_path}`,
    input.old_string,
    input.new_string,
    "", "",
    { context: 3 },
  );

  // Strip the "Index:" / "===" preamble, keep --- / +++ / @@ lines onward.
  const lines = patch.split("\n");
  const start = lines.findIndex((l) => l.startsWith("---"));
  const diffLines = start >= 0 ? lines.slice(start) : lines;

  const body = truncateLines(diffLines, MAX_LINES);
  const header = escapeMarkdownV2(`\u270f\ufe0f Edit: ${input.file_path}`);
  return `${header}\n\`\`\`diff\n${body}\n\`\`\``;
}

function formatWritePreview(input: WriteInput): string {
  const lines = input.content.split("\n");
  const totalLines = lines.length;
  const body = truncateLines(lines, MAX_LINES);
  const header = escapeMarkdownV2(
    `\ud83d\udcc4 Write: ${input.file_path} (${totalLines} lines)`,
  );
  return `${header}\n\`\`\`\n${body}\n\`\`\``;
}

function truncateLines(lines: string[], max: number): string {
  if (lines.length <= max) {
    return lines.join("\n");
  }
  const shown = lines.slice(0, max).join("\n");
  const remaining = lines.length - max;
  return `${shown}\n... (${remaining} more lines)`;
}

// Tools whose output is noisy or redundant (tool_use already shows input).
// New/unknown tools show by default.
const SUPPRESSED_RESULTS = new Set([
  "Read", "Edit", "Write", "Glob", "Agent",
  "TodoWrite", "NotebookEdit", "EnterPlanMode", "ExitPlanMode",
]);

/**
 * Format a tool_result event for display. Returns a MarkdownV2 code block
 * with input + output, or null if suppressed/empty.
 */
export function formatToolResult(
  toolName: string,
  output: string,
): string | null {
  if (SUPPRESSED_RESULTS.has(toolName)) return null;
  if (!output.trim()) return null;
  const body = truncateLines(output.split("\n"), MAX_LINES);
  return `\`\`\`\n${body}\n\`\`\``;
}

/**
 * Escape special characters for MarkdownV2 (outside code blocks).
 * Inside ``` blocks, no escaping is needed.
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Human-readable one-liner for a tool invocation (used in permission prompts).
 */
export function formatToolDescription(
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
