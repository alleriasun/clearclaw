/**
 * Formatting utilities for Telegram display.
 *
 * Uses the `diff` library for unified diffs in Edit permission prompts.
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

const MAX_STATUS_LEN = 60;

/**
 * Summary line for the rolling tool message after a turn completes.
 * e.g. "🔧 3× Read, 2× Grep, 1× Bash"
 */
export function formatToolCallSummary(
  toolCalls: Record<string, number>,
): string | null {
  const entries = Object.entries(toolCalls);
  if (entries.length === 0) return null;
  const breakdown = entries
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `${count}× ${name}`)
    .join(", ");
  return `🔧 ${breakdown}`;
}

/**
 * Short one-liner for the rolling tool message. Includes key detail
 * but truncated to stay compact.
 */
export function formatToolStatusLine(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const full = `🔧 ${formatToolStatus(toolName, input)}`;
  if (full.length <= MAX_STATUS_LEN) return full;
  return `${full.slice(0, MAX_STATUS_LEN - 1)}…`;
}

/**
 * Format a permission prompt for display. Returns a MarkdownV2 string.
 * Edit/Write include the diff/preview; other tools get a one-line description.
 */
export function formatPermissionPrompt(
  toolName: string,
  input: Record<string, unknown>,
  description: string,
): string {
  if (toolName === "Edit") {
    const edit = input as unknown as EditInput;
    const patch = createTwoFilesPatch(
      `a/${edit.file_path}`,
      `b/${edit.file_path}`,
      edit.old_string,
      edit.new_string,
      "", "",
      { context: 3 },
    );
    const lines = patch.split("\n");
    const start = lines.findIndex((l) => l.startsWith("---"));
    const diffLines = start >= 0 ? lines.slice(start) : lines;
    const body = truncateLines(diffLines, MAX_LINES);
    return `🔐 Allow Edit? ${edit.file_path}\n\`\`\`diff\n${body}\n\`\`\``;
  }

  if (toolName === "Write") {
    const write = input as unknown as WriteInput;
    const lines = write.content.split("\n");
    const body = truncateLines(lines, MAX_LINES);
    return `🔐 Allow Write? ${write.file_path} (${lines.length} lines)\n\`\`\`\n${body}\n\`\`\``;
  }

  // Non-Edit/Write tools: emoji header + detail in code block
  const detail = formatToolDetail(toolName, input);
  const body = truncateLines(detail.split("\n"), MAX_LINES);
  return `🔐 Allow ${toolName}?\n\`\`\`\n${body}\n\`\`\``;
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
    case "Edit":
      return `Edit: ${input.file_path ?? "(unknown)"}`;
    case "Write":
      return `Write: ${input.file_path ?? "(unknown)"}`;
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

/** Extract the key detail for a tool's permission prompt (command, query, URL, etc.). */
function formatToolDetail(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "Bash":
      return String(input.command ?? "");
    case "Read":
    case "Edit":
    case "Write":
      return String(input.file_path ?? "");
    case "Glob":
    case "Grep":
      return String(input.pattern ?? "");
    case "WebSearch":
      return String(input.query ?? "");
    case "WebFetch":
      return String(input.url ?? "");
    case "Agent":
      return String(input.description ?? "");
    default:
      return JSON.stringify(input, null, 2);
  }
}

/**
 * Relative time string: "just now", "5m ago", "2h ago", "3d ago".
 */
export function timeAgo(epochMs: number): string {
  const seconds = Math.floor((Date.now() - epochMs) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const MAX_BTN = 45;

interface AskUserQuestionOption {
  label: string;
  description: string;
}

interface AskUserQuestionInput {
  questions: {
    question: string;
    header: string;
    options: AskUserQuestionOption[];
    multiSelect: boolean;
  }[];
}

/**
 * Format the first question from an AskUserQuestion tool call.
 * Returns { text, options } where options are the parsed option objects.
 */
export function formatAskUserQuestion(input: Record<string, unknown>): {
  text: string;
  options: AskUserQuestionOption[];
} {
  const { questions } = input as unknown as AskUserQuestionInput;
  const q = questions[0];
  const lines = [`❓ ${q.header}`, q.question, ""];
  for (let i = 0; i < q.options.length; i++) {
    const opt = q.options[i];
    lines.push(`${i + 1}. ${opt.label} — ${opt.description}`);
  }
  return { text: lines.join("\n"), options: q.options };
}

/**
 * Truncate a button label to MAX_BTN chars with number prefix.
 */
export function truncateButtonLabel(index: number, label: string): string {
  const full = `${index + 1}. ${label}`;
  if (full.length <= MAX_BTN) return full;
  return `${full.slice(0, MAX_BTN - 1)}…`;
}

/**
 * Format an ExitPlanMode permission prompt.
 * Renders plan text from the description or input fields.
 */
export function formatExitPlanMode(
  input: Record<string, unknown>,
  description: string,
): string {
  const plan = description
    || (typeof input.plan === "string" ? input.plan : null)
    || JSON.stringify(input, null, 2);
  const lines = plan.split("\n");
  const body = truncateLines(lines, MAX_LINES);
  return `📋 Plan Review\n\n${body}`;
}

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

/**
 * Format a TodoWrite task list for display.
 */
export function formatTodoList(input: Record<string, unknown>): string {
  const todos = (input.todos ?? []) as TodoItem[];
  if (todos.length === 0) return "📋 Tasks\n(empty)";
  const lines = todos.map((t) => {
    switch (t.status) {
      case "completed": return `✅ ${t.content}`;
      case "in_progress": return `⏳ ${t.activeForm}`;
      default: return `⬚ ${t.content}`;
    }
  });
  return `📋 Tasks\n${lines.join("\n")}`;
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
 * Human-readable one-liner for a tool invocation (used in engine's canUseTool).
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
