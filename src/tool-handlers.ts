/**
 * Per-tool custom handlers for permission prompts and display.
 *
 * Permission handlers replace the default Allow/Deny prompt with tool-specific
 * UI (e.g. option buttons for AskUserQuestion, approve/reject for ExitPlanMode).
 *
 * Display handlers suppress the default rolling tool status line for tools that
 * have their own display logic (or should be invisible to the user).
 */

import type { Button, ButtonResponse, PermissionResponse } from "./types.js";
import {
  formatAskUserQuestion,
  formatExitPlanMode,
  truncateButtonLabel,
} from "./format.js";

// --- Types ---

export interface ToolPromptResult {
  text: string;
  buttons: Button[][];
  mapResponse: (resp: ButtonResponse) => PermissionResponse;
}

export type ToolPromptHandler = (
  input: Record<string, unknown>,
  description: string,
) => ToolPromptResult | null;

// --- Permission Handlers ---

function handleAskUserQuestion(
  input: Record<string, unknown>,
): ToolPromptResult | null {
  const { text, options } = formatAskUserQuestion(input);

  const buttons: Button[][] = options.map((opt, i) => [
    { label: truncateButtonLabel(i, opt.label), value: opt.label },
  ]);
  buttons.push([{ label: "Other…", value: "__other__", requestText: true }]);

  return {
    text,
    buttons,
    mapResponse(resp: ButtonResponse): PermissionResponse {
      const answer = resp.value === "__other__"
        ? (resp.text ?? "")
        : resp.value;

      const questions = (input as Record<string, unknown>).questions as Record<string, unknown>[];
      const questionText = (questions[0] as Record<string, unknown>).question as string;

      return {
        decision: "allow",
        updatedInput: {
          ...input,
          answers: { [questionText]: answer },
        },
      };
    },
  };
}

function handleExitPlanMode(
  input: Record<string, unknown>,
  description: string,
): ToolPromptResult | null {
  const text = formatExitPlanMode(input, description);

  return {
    text,
    buttons: [
      [
        { label: "👍 Approve", value: "approve" },
        { label: "👎 Reject", value: "reject" },
      ],
      [
        { label: "📝 Reject + Note", value: "reject", requestText: true },
      ],
    ],
    mapResponse(resp: ButtonResponse): PermissionResponse {
      if (resp.value === "approve") {
        return { decision: "allow", updatedInput: input };
      }
      return {
        decision: "deny",
        message: resp.text ?? "Plan rejected",
      };
    },
  };
}

// --- Exported maps ---

export const permissionHandlers = new Map<string, ToolPromptHandler>([
  ["AskUserQuestion", handleAskUserQuestion],
  ["ExitPlanMode", handleExitPlanMode],
]);

/** Tools that suppress the default rolling status line in routeEngineEvent. */
export const displayHandledTools = new Set<string>([
  "AskUserQuestion",
  "ExitPlanMode",
  "EnterPlanMode",
  "TodoWrite",
]);
