import type { SessionMessage } from "../types.js";

/** Format all engine-normalized conversation text for a handoff prompt. */
export function formatSessionTranscript(messages: SessionMessage[]): string {
  let text = "";
  for (const message of messages) {
    if (!message.text.trim()) continue;
    text += `${text ? "\n\n" : ""}${message.role === "user" ? "User" : "Assistant"}:\n${message.text}`;
  }
  return text || "[No conversation text was returned for the previous session.]";
}
