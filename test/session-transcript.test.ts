import assert from "node:assert/strict";
import test from "node:test";
import { formatSessionTranscript } from "../src/engine/session-transcript.js";

test("formats normalized history in order and skips blank text", () => {
  assert.equal(formatSessionTranscript([
    { role: "user", text: "Please fix the bug" },
    { role: "assistant", text: "  " },
    { role: "assistant", text: "The bug is fixed" },
  ]), "User:\nPlease fix the bug\n\nAssistant:\nThe bug is fixed");
});

test("preserves the complete conversation beyond the former 24000-character cap", () => {
  const opening = "Old opening " + "x".repeat(30_000);
  const transcript = formatSessionTranscript([
    { role: "user", text: opening },
    { role: "assistant", text: "Newest answer" },
  ]);
  assert.equal(transcript, `User:\n${opening}\n\nAssistant:\nNewest answer`);
});

test("empty history is explicit", () => {
  assert.equal(formatSessionTranscript([]), "[No conversation text was returned for the previous session.]");
});
