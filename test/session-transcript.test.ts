import assert from "node:assert/strict";
import test from "node:test";
import { formatSessionTranscript, stripPromptPrefix } from "../src/engine/session-transcript.js";

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

test("stripPromptPrefix removes ClearClaw's prompt framing", () => {
  // Real summaries observed from listSessions on a ClearClaw workspace.
  assert.equal(
    stripPromptPrefix("[2026-09-10 Thu 09:31 PDT] [msg:10107] [user] Paddy Sun (@fateakong): let's spin out a new workspace"),
    "let's spin out a new workspace",
  );
  assert.equal(
    stripPromptPrefix("[Replying to Paddy Sun msg:9258] [2026-09-08 Tue 11:25 PDT] [msg:9282] [user] Paddy Sun (@fateakong): ok let's start"),
    "ok let's start",
  );
  assert.equal(
    stripPromptPrefix("[2026-09-08 Tue 19:00 PDT] [scheduler] 8e5222b2: Run the RSS digest."),
    "Run the RSS digest.",
  );
  // Older single-bracket form the previous regex was written for.
  assert.equal(stripPromptPrefix("[Paddy (@fateakong)]: hi"), "hi");
});

test("stripPromptPrefix leaves untagged text alone", () => {
  assert.equal(stripPromptPrefix("/login"), "/login");
  assert.equal(stripPromptPrefix("Fix: add retry logic"), "Fix: add retry logic");
});
