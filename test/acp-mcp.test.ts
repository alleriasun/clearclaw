import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { AcpEngine } from "../src/engine/acp.js";
import type { EngineEvent, RunTurnOpts } from "../src/types.js";

interface Trace {
  pid: number;
  phase: string;
  method?: string;
  sessionId?: string;
  configId?: string;
  value?: string;
  servers?: Array<{ name: string; type: string; url: string }>;
}

async function fixture(t: TestContext, mode = "success", engineName = "codex") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clearclaw-acp-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tracePath = path.join(dir, "trace.jsonl");
  const controller = new AbortController();
  t.after(() => controller.abort());
  const calls: string[] = [];
  const engine = new AcpEngine(engineName, {
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/acp-mcp-agent.mjs", import.meta.url)), mode, tracePath],
  });
  const opts: RunTurnOpts = {
    sessionId: null,
    cwd: dir,
    prompt: "Call turn_context",
    permissionMode: "bypassPermissions",
    onPermissionRequest: async () => ({ decision: "allow" }),
    signal: controller.signal,
    mcpServers: {
      clearclaw: createSdkMcpServer({ name: "clearclaw", tools: [
        tool("turn_context", "Read this fixture turn's context", {}, async () => {
          calls.push(mode);
          return { content: [{ type: "text", text: `context:${mode}` }] };
        }),
      ] }),
    },
  };
  const traces = async (): Promise<Trace[]> => {
    const data = await readFile(tracePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return data.trim() ? data.trim().split("\n").map((line) => JSON.parse(line)) : [];
  };
  return { engine, opts, controller, calls, traces };
}

async function collect(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const result: EngineEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(10);
  }
  throw new Error("Fixture did not reach expected state within 5 seconds");
}

async function assertClosed(traces: Trace[]) {
  for (const server of traces.find((entry) => entry.phase === "setup")?.servers ?? []) {
    await assert.rejects(fetch(server.url), "turn's MCP endpoint must be closed");
  }
  const pid = traces[0]?.pid;
  assert.ok(pid, "fixture must have started");
  await waitFor(async () => {
    try { process.kill(pid, 0); return undefined; }
    catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return true;
    }
  });
}

test("Codex new and resumed ACP sessions select the model before calling the current turn's SDK handler", { timeout: 15000 }, async (t) => {
  for (const sessionId of [null, "resumed-session"]) {
    const f = await fixture(t);
    const events = await collect(f.engine.runTurn({ ...f.opts, sessionId, model: "fixture-model" }));
    const done = events.at(-1);
    assert.ok(done?.type === "done");
    assert.equal(done.stats.contextUsed, 250);
    assert.equal(done.stats.contextWindow, 2000);
    assert.deepEqual(f.calls, ["success"]);
    const text = events.find((event) => event.type === "text_chunk");
    assert.ok(text?.type === "text_chunk");
    assert.deepEqual(JSON.parse(text.text), {
      method: sessionId ? "load" : "new",
      result: { content: [{ type: "text", text: "context:success" }] },
    });
    const traces = await f.traces();
    assert.deepEqual(traces.map((entry) => entry.phase), ["initialize", "setup", "model", "prompt"]);
    const model = traces.find((entry) => entry.phase === "model")!;
    assert.equal(model.sessionId, sessionId ?? "fixture-session");
    assert.equal(model.configId, "fixture-model-selector");
    assert.equal(model.value, "fixture-model");
    const setup = traces.find((entry) => entry.phase === "setup")!;
    assert.equal(setup.servers?.[0].name, "clearclaw");
    assert.equal(setup.servers?.[0].type, "http");
    await assertClosed(traces);
  }
});

test("rejected Codex models close the new/resumed session MCP bridge without calling tools", { timeout: 15000 }, async (t) => {
  for (const sessionId of [null, "resumed-session"]) {
    const f = await fixture(t, "reject-model");
    const events = await collect(f.engine.runTurn({ ...f.opts, sessionId, model: "invalid-model" }));
    assert.deepEqual(events, [
      { type: "session", sessionId: sessionId ?? "fixture-session" },
      { type: "error", message: "Fixture rejected model" },
    ]);
    const traces = await f.traces();
    assert.deepEqual(traces.map((entry) => entry.phase), ["initialize", "setup", "model"]);
    assert.deepEqual(f.calls, []);
    await assertClosed(traces);
  }
});

test("ACP session setup failures and child exits close the MCP bridge", { timeout: 15000 }, async (t) => {
  for (const mode of ["fail-setup", "exit-setup"]) {
    const f = await fixture(t, mode);
    const events = await collect(f.engine.runTurn(f.opts));
    const error = events.find((event) => event.type === "error");
    assert.ok(error?.type === "error");
    assert.match(error.message, mode === "fail-setup" ? /Internal error/ : /process exited/);
    assert.deepEqual(f.calls, []);
    await assertClosed(await f.traces());
  }
});

test("ACP cancellation during initialize/load and consumer return release turn resources", { timeout: 20000 }, async (t) => {
  for (const mode of ["hang-initialize", "hang-load"]) {
    const f = await fixture(t, mode);
    const pending = collect(f.engine.runTurn({ ...f.opts, sessionId: "resumed-session" }));
    await waitFor(async () => (await f.traces()).find((entry) => entry.phase === (mode === "hang-initialize" ? "initialize" : "setup")));
    f.controller.abort();
    assert.deepEqual(await pending, []);
    await assertClosed(await f.traces());
  }
  const f = await fixture(t, "hang-prompt");
  const iterator = f.engine.runTurn(f.opts)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, "session");
  await iterator.return!();
  await assertClosed(await f.traces());
});

test("an agent without HTTP MCP runs toolless, whatever it is called", { timeout: 15000 }, async (t) => {
  for (const engineName of ["codex", "kiro"]) {
    const f = await fixture(t, "unsupported", engineName);
    const events = await collect(f.engine.runTurn(f.opts));
    assert.equal(events.at(-1)?.type, "done");
    assert.deepEqual((await f.traces()).find((entry) => entry.phase === "setup")?.servers, []);
    assert.deepEqual(f.calls, []);
    await assertClosed(await f.traces());
  }
});

test("an agent advertising HTTP MCP gets the tools, whatever it is called", { timeout: 15000 }, async (t) => {
  const kiro = await fixture(t, "success", "kiro");
  const events = await collect(kiro.engine.runTurn(kiro.opts));
  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(kiro.calls, ["success"]);
  await assertClosed(await kiro.traces());
});
