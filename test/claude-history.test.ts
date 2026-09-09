import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeCodeEngine } from "../src/engine/claude-code.js";

const sessionId = "11111111-2222-3333-4444-555555555555";

test("Claude SDK reads a synthetic local conversation chain and filters tool blocks", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-claude-history-")));
  const f = { root, cwd: path.join(root, "project") };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(f.root, "claude");
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  });
  fs.mkdirSync(f.cwd, { recursive: true });
  const projectDirectory = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", f.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(projectDirectory, { recursive: true });
  const records = [
    { type: "user", uuid: "user-1", parentUuid: null, sessionId, cwd: f.cwd, isSidechain: false,
      message: { role: "user", content: "A synthetic request" } },
    { type: "assistant", uuid: "assistant-1", parentUuid: "user-1", sessionId, cwd: f.cwd, isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text: "A synthetic reply" }, { type: "tool_use", name: "secret tool" }, { type: "thinking", thinking: "private reasoning" }] } },
  ];
  fs.writeFileSync(path.join(projectDirectory, `${sessionId}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const engine = new ClaudeCodeEngine();
  assert.deepEqual(await engine.getSessionMessages({ sessionId, cwd: f.cwd }), [
    { role: "user", text: "A synthetic request" },
    { role: "assistant", text: "A synthetic reply" },
  ]);
  await assert.rejects(engine.getSessionMessages({
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", cwd: f.cwd,
  }), /No conversation history available/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(engine.getSessionMessages({ sessionId, cwd: f.cwd, signal: abort.signal }), { name: "AbortError" });
});
