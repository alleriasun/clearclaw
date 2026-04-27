/**
 * Formatting utilities for Telegram display.
 *
 * Uses the `diff` library for unified diffs in Edit permission prompts.
 */

import { createTwoFilesPatch } from "diff";
import { isKnownToolCall, type ToolCall } from "./types.js";

const MAX_LINES = 200;
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
export function formatToolStatusLine(tool: ToolCall): string {
  const full = `🔧 ${formatToolStatus(tool)}`;
  if (full.length <= MAX_STATUS_LEN) return full;
  return `${full.slice(0, MAX_STATUS_LEN - 1)}…`;
}

/**
 * Format a permission prompt for display.
 * Switches on action type: edit shows diff, write shows preview,
 * execute shows command, others show available detail.
 */
export function formatPermissionPrompt(tool: ToolCall): string {
  const detail = formatToolDetail(tool);
  if (!detail) return `🔐 Allow ${tool.toolName}?`;
  return `🔐 Allow ${tool.toolName}?\n${detail}`;
}

/** Multi-line detail for permission prompts (diff, content preview, command, etc.). */
function formatToolDetail(tool: ToolCall): string | null {
  if (!isKnownToolCall(tool)) return formatUnknownDetail(tool);
  switch (tool.action) {
    case "edit": {
      if (!tool.before && !tool.after) return tool.path;
      const patch = createTwoFilesPatch(
        `a/${tool.path}`, `b/${tool.path}`,
        tool.before, tool.after, "", "",
        { context: 3 },
      );
      const lines = patch.split("\n");
      const start = lines.findIndex((l) => l.startsWith("---"));
      const diffLines = start >= 0 ? lines.slice(start) : lines;
      return `${tool.path}\n\`\`\`diff\n${truncateLines(diffLines, MAX_LINES)}\n\`\`\``;
    }
    case "write": {
      const lines = tool.content.split("\n");
      return `${tool.path} (${lines.length} lines)\n\`\`\`\n${truncateLines(lines, MAX_LINES)}\n\`\`\``;
    }
    case "execute":
      return `\`\`\`\n${truncateLines(tool.command.split("\n"), MAX_LINES)}\n\`\`\``;
    case "read":
      return `\`\`\`\n${tool.paths.join("\n")}\n\`\`\``;
    case "search":
      return `\`\`\`\n${tool.pattern}\n\`\`\``;
    case "fetch":
      return `\`\`\`\n${tool.url}\n\`\`\``;
  }
}

/** One-liner summary for tool status display. */
function formatToolStatus(tool: ToolCall): string {
  if (!isKnownToolCall(tool)) {
    const summary = formatUnknownSummary(tool);
    return summary ? `${tool.toolName}: ${summary}` : tool.toolName;
  }
  switch (tool.action) {
    case "edit":
    case "write":
      return `${tool.toolName}: ${tool.path}`;
    case "execute":
      return `${tool.toolName}: ${tool.command}`;
    case "read":
      return `${tool.toolName}: ${tool.paths.join(", ")}`;
    case "search":
      return `${tool.toolName}: ${tool.pattern}`;
    case "fetch":
      return `${tool.toolName}: ${tool.url}`;
  }
}

/** Extract displayable info from an unknown tool call's generic fields. */
function formatUnknownSummary(tool: ToolCall): string | null {
  const parts: string[] = [];
  if ("paths" in tool && Array.isArray(tool.paths)) parts.push(...tool.paths);
  if ("detail" in tool && tool.detail) parts.push(String(tool.detail));
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatUnknownDetail(tool: ToolCall): string | null {
  const summary = formatUnknownSummary(tool);
  if (!summary) return null;
  return `\`\`\`\n${truncateLines(summary.split("\n"), MAX_LINES)}\n\`\`\``;
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
): string {
  const plan = (typeof input.plan === "string" ? input.plan : null)
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

