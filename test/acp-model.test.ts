import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { AcpEngine } from "../src/engine/acp.js";
import type { EngineEvent, RunTurnOpts } from "../src/types.js";

interface Trace {
  pid?: number;
  method?: string;
  params?: { sessionId?: string; configId?: string; value?: string };
}

async function waitFor(read: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await read()) return;
    await delay(10);
  }
  assert.fail("Fixture did not reach expected state within 5 seconds");
}

async function fixture(t: TestContext, mode = "success", name = "codex") {
  const root = await mkdtemp(join(tmpdir(), "clearclaw-model-test-"));
  const tracePath = join(root, "requests.jsonl");
  const controller = new AbortController();
  const traces = async (): Promise<Trace[]> => {
    const data = await readFile(tracePath, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return "";
      throw err;
    });
    return data.trim() ? data.trim().split("\n").map((line) => JSON.parse(line)) : [];
  };
  const assertClosed = async () => {
    const pid = (await traces())[0]?.pid;
    assert.ok(pid, "fixture must have started");
    await waitFor(async () => {
      try { process.kill(pid, 0); return false; }
      catch (err) { assert.equal((err as NodeJS.ErrnoException).code, "ESRCH"); return true; }
    });
  };
  t.after(async () => {
    controller.abort();
    await assertClosed();
    await rm(root, { recursive: true });
  });
  const engine = new AcpEngine(name, {
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/acp-model-agent.mjs", import.meta.url)), mode, tracePath],
  });
  const opts: RunTurnOpts = {
    sessionId: null, cwd: root, prompt: "Continue", permissionMode: "default",
    onPermissionRequest: async () => ({ decision: "deny" }), signal: controller.signal,
  };
  return { engine, opts, traces, controller, assertClosed };
}

async function collect(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const result: EngineEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

test("ACP forwards live plan metadata separately from context and ignores quota replay", async (t) => {
  const f = await fixture(t, "quota");
  const events = await collect(f.engine.runTurn({ ...f.opts, sessionId: "resumed-session" }));
  const quota = events.filter((event) => event.type === "plan_usage");
  assert.equal(quota.length, 1);
  assert.deepEqual(quota[0].windows.map((window) => window.usedPercent), [47, 18]);
  const done = events.find((event) => event.type === "done");
  assert.equal(done?.stats?.contextUsed, 250);
  assert.equal(done?.stats?.contextWindow, 1000);
});

for (const sessionId of [null, "resumed-session"]) {
  test(`ACP uses the advertised selector before prompting a ${sessionId ? "resumed" : "new"} session`, async (t) => {
    const f = await fixture(t, "success", "custom-agent");
    const events = await collect(f.engine.runTurn({ ...f.opts, sessionId, model: "fixture-model" }));
    assert.deepEqual(events.map((event) => event.type), ["session", "text_chunk", "done"]);
    assert.deepEqual(events[0], { type: "session", sessionId: sessionId ?? "fixture-session" });
    assert.deepEqual(events[1], { type: "text_chunk", text: "Model answered" });
    const traces = (await f.traces()).filter((entry) => entry.method);
    assert.deepEqual(traces.map((entry) => entry.method), [
      "initialize", sessionId ? "session/load" : "session/new", "session/set_config_option", "session/prompt",
    ]);
    assert.deepEqual(traces[2].params, { sessionId: sessionId ?? "fixture-session", configId: "custom-model-selector", value: "fixture-model" });
  });
}

test("rejected model selection preserves the session, reports the adapter error, and does not prompt", async (t) => {
  for (const sessionId of [null, "resumed-session"]) {
    const f = await fixture(t, "reject-model");
    const events = await collect(f.engine.runTurn({ ...f.opts, sessionId, model: "invalid-model" }));
    assert.deepEqual(events, [
      { type: "session", sessionId: sessionId ?? "fixture-session" },
      { type: "error", message: "Fixture rejected model" },
    ]);
    assert.equal((await f.traces()).some((entry) => entry.method === "session/prompt"), false);
  }
});

test("an advertised model ID works without the optional category", async (t) => {
  const f = await fixture(t, "uncategorized");
  await collect(f.engine.runTurn({ ...f.opts, model: "fixture-model" }));
  const request = (await f.traces()).find((entry) => entry.method === "session/set_config_option");
  assert.equal(request?.params?.configId, "model");
});

test("an explicit override without an advertised model selector errors without prompting", async (t) => {
  for (const mode of ["no-config", "unrelated-config"]) {
    const f = await fixture(t, mode);
    const events = await collect(f.engine.runTurn({ ...f.opts, model: "fixture-model" }));
    assert.deepEqual(events, [
      { type: "session", sessionId: "fixture-session" },
      { type: "error", message: "codex did not advertise a model selector" },
    ]);
    assert.deepEqual((await f.traces()).filter((entry) => entry.method).map((entry) => entry.method),
      ["initialize", "session/new"]);
  }
});

test("absent overrides leave the agent's model unchanged with or without config options", async (t) => {
  for (const mode of ["success", "no-config"]) {
    const f = await fixture(t, mode);
    const events = await collect(f.engine.runTurn(f.opts));
    assert.equal(events.at(-1)?.type, "done");
    assert.equal((await f.traces()).some((entry) => entry.method === "session/set_config_option"), false);
  }
});

for (const [mode, used, size] of [
  ["usage-load", 800, 1000], ["usage-live", 250, 2000], ["usage-zero", 0, 2000], ["success", 0, 0],
] as const) {
  test(`ACP context usage: ${mode} retains the latest reported window`, async (t) => {
    const f = await fixture(t, mode, "custom-agent");
    const events = await collect(f.engine.runTurn({ ...f.opts, sessionId: "resumed-session" }));
    assert.deepEqual(events.filter((event) => event.type === "text_chunk"),
      [{ type: "text_chunk", text: "Model answered" }], "history replay stays suppressed");
    const done = events.at(-1);
    assert.equal(done?.type, "done");
    if (done?.type !== "done") assert.fail("Expected completed turn");
    assert.equal(done.stats.contextUsed, used);
    assert.equal(done.stats.contextWindow, size);
  });
}
