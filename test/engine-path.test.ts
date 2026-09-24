import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createEngineMap, engineCommand, resolveEnginePath } from "../src/engine/registry.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "clearclaw-engine-path-"));
  const log = join(root, "calls.jsonl");
  const source = readFileSync(new URL("./fixtures/engine-path-cli.mjs", import.meta.url), "utf8");
  const executable = (name: string) => {
    const path = join(root, name);
    writeFileSync(path, `#!${process.execPath}\n${source}`, { mode: 0o755 });
    return path;
  };
  const environment = {
    CODEX_HOME: root, CODEX_PATH: executable("inherited-codex"),
    CODEX_CONFIG: JSON.stringify({ model: "inherited-model" }),
    ENGINE_PATH_LOG: log, ENGINE_PATH_CWD: root, ENGINE_PATH_FAIL_INIT: "0",
    // Accidental PATH fallback must fail, never launch a real installed agent.
    PATH: root,
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, executable, calls: () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
}

test("setup resolves each engine's CLI, not the ACP adapter host", () => {
  assert.equal(engineCommand("claude-code"), "claude");
  assert.equal(engineCommand("kiro"), "kiro-cli");
  assert.equal(engineCommand("codex"), "codex");
  assert.equal(engineCommand("unknown"), undefined);
});

test("Kiro launches the configured executable with ACP arguments", async (t) => {
  const f = fixture(t);
  const path = f.executable("custom kiro");
  const sessions = await createEngineMap({ kiro: path }).get("kiro")!.listSessions(f.root);
  assert.equal(sessions[0].sessionId, "configured-cli");
  assert.deepEqual(f.calls()[0].args, ["acp"]);
  assert.equal(f.calls()[0].executable, path);
});

test("Codex's real ACP adapter launches the configured CLI even without a system prompt", async (t) => {
  const f = fixture(t);
  const path = f.executable("custom codex");
  const sessions = await createEngineMap({ codex: path }).get("codex")!.listSessions(f.root);
  assert.equal(sessions[0].sessionId, "configured-cli");
  const launch = f.calls()[0];
  assert.equal(launch.executable, path);
  assert.deepEqual(launch.args, ["app-server"]);
  assert.deepEqual(JSON.parse(launch.config), { model: "inherited-model" });
  assert.ok(f.calls().some((call) => call.method === "thread/list"));
});

test("Codex retains adapter fallback for an unset executable path", async (t) => {
  const f = fixture(t);
  const sessions = await createEngineMap().get("codex")!.listSessions(f.root);
  assert.equal(sessions[0].sessionId, "configured-cli");
  assert.equal(f.calls()[0].executable, process.env.CODEX_PATH);
  assert.deepEqual(f.calls()[0].args, ["app-server"]);
});


test("Codex path override preserves inherited config and the assembled prompt", async (t) => {
  const f = fixture(t);
  process.env.ENGINE_PATH_FAIL_INIT = "1";
  const path = f.executable("codex-with-prompt");
  const events = [];
  for await (const event of createEngineMap({ codex: path }).get("codex")!.runTurn({
    sessionId: null, cwd: f.root, prompt: "unused", permissionMode: "default",
    appendSystemPrompt: "  Framework instructions  ",
    onPermissionRequest: async () => ({ decision: "deny" }),
  })) events.push(event);
  assert.ok(events.some((event) => event.type === "error"));
  assert.equal(f.calls()[0].executable, path);
  assert.deepEqual(JSON.parse(f.calls()[0].config), {
    model: "inherited-model", developer_instructions: "Framework instructions",
  });
  assert.deepEqual(JSON.parse(process.env.CODEX_CONFIG!), { model: "inherited-model" });
});

for (const name of ["kiro", "codex"]) {
  test(`${name} reports a missing configured executable rather than falling back`, async (t) => {
    const f = fixture(t);
    await assert.rejects(createEngineMap({ [name]: join(f.root, "absent-cli") }).get(name)!.listSessions(f.root));
    assert.throws(f.calls, { code: "ENOENT" });
  });
}


test("Codex setup prefers an installed CLI and otherwise keeps the bundled fallback", (t) => {
  const f = fixture(t);
  process.env.PATH = `${f.root}:/usr/bin:/bin`;
  assert.equal(resolveEnginePath("codex"), undefined);
  const path = f.executable("codex");
  assert.equal(resolveEnginePath("codex"), path);
});

for (const name of ["claude-code", "kiro"]) {
  test(`${name} setup still requires an installed CLI`, (t) => {
    const f = fixture(t);
    process.env.PATH = `${f.root}:/usr/bin:/bin`;
    assert.throws(() => resolveEnginePath(name), /not found on PATH/);
    const path = f.executable(engineCommand(name)!);
    assert.equal(resolveEnginePath(name), path);
  });
}
