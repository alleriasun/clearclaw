/**
 * Diff formatting utilities for tool_use display in Telegram.
 *
 * V1: simple dump — all old_string lines as `-`, all new_string lines as `+`.
 * Future: swap in a diff library for proper line-level diffing.
 */

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
 * Format a tool_use event for display. Returns a MarkdownV2 string,
 * or null if we don't format this tool.
 */
export function formatToolUse(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (toolName === "Edit") {
    return formatEditDiff(input as unknown as EditInput);
  }
  if (toolName === "Write") {
    return formatWritePreview(input as unknown as WriteInput);
  }
  return null;
}

function formatEditDiff(input: EditInput): string {
  const oldLines = input.old_string.split("\n");
  const newLines = input.new_string.split("\n");

  const diffLines = [
    `--- a/${input.file_path}`,
    `+++ b/${input.file_path}`,
    ...oldLines.map((l) => `- ${l}`),
    ...newLines.map((l) => `+ ${l}`),
  ];

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

/**
 * Escape special characters for MarkdownV2 (outside code blocks).
 * Inside ``` blocks, no escaping is needed.
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
