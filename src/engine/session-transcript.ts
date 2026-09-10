import type { SessionMessage } from "../types.js";

/**
 * Inverse of the orchestrator's prompt framing, for showing a stored prompt back
 * to a human (session summaries, catch-up blocks): drop the leading bracketed
 * tags and the sender label.
 * "[2026-09-10 …] [msg:10107] [user] Paddy (@handle): hi" → "hi".
 * Text with no bracketed tag is left alone, so a summary that merely contains a
 * colon keeps its first clause.
 */
export function stripPromptPrefix(text: string): string {
  return text.replace(/^(?:\[[^\]]*\]\s*)+(?:[^:\n]{0,60}:\s*)?/, "");
}

/** Format all engine-normalized conversation text for a handoff prompt. */
export function formatSessionTranscript(messages: SessionMessage[]): string {
  let text = "";
  for (const message of messages) {
    if (!message.text.trim()) continue;
    text += `${text ? "\n\n" : ""}${message.role === "user" ? "User" : "Assistant"}:\n${message.text}`;
  }
  return text || "[No conversation text was returned for the previous session.]";
}
