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
  const executable = (name: string, body = source) => {
    const path = join(root, name);
    writeFileSync(path, `#!${process.execPath}\n${body}`, { mode: 0o755 });
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
  const sessions = await createEngineMap({ kiro: { path } }).get("kiro")!.listSessions(f.root);
  assert.equal(sessions[0].sessionId, "configured-cli");
  assert.deepEqual(f.calls()[0].args, ["acp"]);
  assert.equal(f.calls()[0].executable, path);
});

test("Codex's real ACP adapter launches the configured CLI even without a system prompt", async (t) => {
  const f = fixture(t);
  const path = f.executable("custom codex");
  const sessions = await createEngineMap({ codex: { path } }).get("codex")!.listSessions(f.root);
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
  for await (const event of createEngineMap({ codex: { path } }).get("codex")!.runTurn({
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
    await assert.rejects(createEngineMap({ [name]: { path: join(f.root, "absent-cli") } }).get(name)!.listSessions(f.root));
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


test("Codex loads explicit JSON without a prompt and rereads it for each launch", async (t) => {
  const f = fixture(t);
  const configPath = join(f.root, "personal settings.json");
  const config = { model: "file-model", features: { multi_agent: true } };
  writeFileSync(configPath, JSON.stringify(config));
  process.env.CODEX_CONFIG = "invalid inherited JSON must not be used";
  const engine = createEngineMap({ codex: { configPath } }).get("codex")!;
  await engine.listSessions(f.root);
  assert.deepEqual(JSON.parse(f.calls()[0].config), config);
  writeFileSync(configPath, JSON.stringify({ model: "updated-file-model" }));
  await engine.listSessions(f.root);
  const launches = f.calls().filter((call) => call.executable);
  assert.deepEqual(JSON.parse(launches[1].config), { model: "updated-file-model" });
});

test("Codex adds framework instructions over explicit config and retains the CLI override", async (t) => {
  const f = fixture(t);
  const configPath = join(f.root, "settings.json");
  writeFileSync(configPath, JSON.stringify({ features: { multi_agent: true }, developer_instructions: "file prompt" }));
  process.env.ENGINE_PATH_FAIL_INIT = "1";
  const path = f.executable("configured codex");
  const events = [];
  for await (const event of createEngineMap({ codex: { path, configPath } }).get("codex")!.runTurn({
    sessionId: null, cwd: f.root, prompt: "unused", permissionMode: "default",
    appendSystemPrompt: "Framework instructions",
    onPermissionRequest: async () => ({ decision: "deny" }),
  })) events.push(event);
  assert.ok(events.some((event) => event.type === "error"));
  assert.equal(f.calls()[0].executable, path);
  assert.deepEqual(JSON.parse(f.calls()[0].config), {
    features: { multi_agent: true }, developer_instructions: "Framework instructions",
  });
});

for (const content of [undefined, "", "{broken", "[]", "null"]) {
  test(`Codex rejects ${content === undefined ? "missing" : JSON.stringify(content)} config before spawning`, async (t) => {
    const f = fixture(t);
    const configPath = join(f.root, "settings.json");
    if (content !== undefined) writeFileSync(configPath, content);
    await assert.rejects(createEngineMap({ codex: { configPath } }).get("codex")!.listSessions(f.root));
    assert.throws(f.calls, { code: "ENOENT" });
  });
}

for (const key of ["marketplaces", "plugins"]) {
  test(`Codex rejects CLI-owned ${key} in config rather than launching without them`, async (t) => {
    const f = fixture(t);
    const configPath = join(f.root, "settings.json");
    writeFileSync(configPath, JSON.stringify({ model: "file-model", [key]: { name: {} } }));
    await assert.rejects(createEngineMap({ codex: { configPath } }).get("codex")!.listSessions(f.root), new RegExp(`${key}.+codex plugin marketplace add`, "s"));
    assert.throws(f.calls, { code: "ENOENT" });
  });
}

test("configPath requires an absolute path and a supported engine", () => {
  assert.throws(() => createEngineMap({ codex: { configPath: "relative.json" } }), /must be absolute/);
  assert.throws(() => createEngineMap({ kiro: { configPath: "/settings.json" } }), /does not support configPath/);
});

test("Claude SDK forwards explicit settings while keeping user, project and local sources", async (t) => {
  const f = fixture(t);
  const configPath = join(f.root, "personal settings.json");
  writeFileSync(configPath, JSON.stringify({ env: { CLEARCLAW_TEST_SETTING: "configured" } }));
  const path = f.executable("claude-fixture", `import { appendFileSync } from "node:fs";
appendFileSync(process.env.ENGINE_PATH_LOG, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
process.exit(1);`);
  const events = [];
  for await (const event of createEngineMap({ "claude-code": { path, configPath } }).get("claude-code")!.runTurn({
    sessionId: null, cwd: f.root, prompt: "unused", permissionMode: "default",
    signal: AbortSignal.timeout(10000),
    onPermissionRequest: async () => ({ decision: "deny" }),
  })) events.push(event);
  const args = f.calls()[0].args;
  assert.equal(args[args.indexOf("--settings") + 1], configPath);
  assert.ok(args.includes("--setting-sources=user,project,local"));
  assert.ok(events.some((event) => event.type === "error"));
});
