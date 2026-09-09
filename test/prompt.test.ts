import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assemblePrompt } from "../src/prompt.js";

test("an unreadable .md file is reported instead of silently dropped", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-prompt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "USER.md"), "readable content");
  // A directory named *.md fails the read immediately — same code path a
  // cloud-placeholder file reaches via timeout, without the 5s wait.
  fs.mkdirSync(path.join(dir, "BROKEN.md"));

  const { prompt, skipped } = await assemblePrompt("/nonexistent", dir);

  assert.equal(prompt, "readable content");
  assert.deepEqual(skipped, ["BROKEN.md"]);
});

test("nothing readable anywhere yields no prompt but still names the casualties", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-prompt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "BROKEN.md"));

  const { prompt, skipped } = await assemblePrompt("/nonexistent", dir);

  assert.equal(prompt, undefined);
  assert.deepEqual(skipped, ["BROKEN.md"]);
});
