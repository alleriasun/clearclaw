import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
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

test("a directory listing that never returns is skipped instead of hanging the turn", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-prompt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "USER.md"), "readable content");
  // Stands in for a cloud-synced dir whose listing blocks in the threadpool forever.
  const hung = path.join(dir, "cloud");
  fs.mkdirSync(hung);
  const readdir = fsp.readdir;
  t.mock.method(fsp, "readdir", ((p: string, ...rest: []) =>
    p === hung ? new Promise(() => {}) : readdir(p, ...rest)) as typeof fsp.readdir);
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const pending = assemblePrompt(hung, dir);
  t.mock.timers.tick(5000);
  const { prompt, skipped } = await pending;

  assert.equal(prompt, "readable content");
  assert.deepEqual(skipped, [hung]);
});
