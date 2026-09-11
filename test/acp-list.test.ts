import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { AcpEngine } from "../src/engine/acp.js";

function fixture(t: TestContext, mode = "success") {
  const root = mkdtempSync(join(tmpdir(), "clearclaw-list-test-"));
  const log = join(root, "requests.jsonl");
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  t.after(async () => {
    const pid = calls()[0].pid;
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch { rmSync(root, { recursive: true }); return; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Listing adapter did not exit");
  });
  return {
    cwd: root, calls,
    engine: new AcpEngine("fixture", {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/acp-list-agent.mjs", import.meta.url))],
      env: { LIST_MODE: mode, LIST_LOG: log },
    }),
  };
}

test("ACP listing follows sparse pages, scopes cwd, deduplicates, sorts and limits picker entries", async (t) => {
  const f = fixture(t);
  const sessions = await f.engine.listSessions(f.cwd);
  assert.equal(sessions.length, 10);
  assert.deepEqual(sessions[0], { sessionId: "newest", summary: "Session newest", lastModified: Date.parse("2026-09-11T00:00:00Z") });
  assert.ok(sessions.every((s) => s.sessionId !== "sibling" && s.sessionId !== "older"));
  assert.equal(new Set(sessions.map((s) => s.sessionId)).size, 10);
  assert.deepEqual(f.calls().filter((c) => c.method).map((c) => c.method), ["initialize", "session/list", "session/list", "session/list"]);
  assert.deepEqual(f.calls().filter((c) => c.method === "session/list").map((c) => c.params), [
    { cwd: f.cwd }, { cwd: f.cwd, cursor: "page2" }, { cwd: f.cwd, cursor: "page3" },
  ]);
});

test("ACP listing uses IDs for missing titles and marks absent/invalid activity as unknown", async (t) => {
  const f = fixture(t, "missing");
  assert.deepEqual(await f.engine.listSessions(f.cwd), [
    { sessionId: "dated", summary: "Known date", lastModified: Date.parse("2026-09-10T00:00:00Z") },
    { sessionId: "no-title", summary: "no-title", lastModified: 0 },
    { sessionId: "blank-title", summary: "blank-title", lastModified: 0 },
  ]);
});

for (const mode of ["unsupported", "empty"]) {
  test(`ACP listing deliberately returns no entries for ${mode}`, async (t) => {
    const f = fixture(t, mode);
    assert.deepEqual(await f.engine.listSessions(f.cwd), []);
    if (mode === "unsupported") assert.deepEqual(f.calls().filter((c) => c.method).map((c) => c.method), ["initialize"]);
  });
}

for (const [mode, error] of [["error", /Listing failed/], ["exit", /exited|closed/], ["repeat", /repeated.*cursor/]] as const) {
  test(`ACP listing rejects ${mode} and terminates the child`, async (t) => {
    const f = fixture(t, mode);
    await assert.rejects(f.engine.listSessions(f.cwd), error);
  });
}

for (const mode of ["hang-init", "hang"]) {
  test(`ACP listing enforces its 30s deadline during ${mode}`, { timeout: 5000 }, async (t) => {
    const f = fixture(t, mode);
    const controller = new AbortController();
    t.mock.method(AbortSignal, "timeout", (ms: number) => { assert.equal(ms, 30_000); return controller.signal; });
    const pending = f.engine.listSessions(f.cwd);
    const rejected = assert.rejects(pending, { name: "TimeoutError" });
    const method = mode === "hang-init" ? "initialize" : "session/list";
    for (let i = 0; i < 100; i++) {
      try { if (f.calls().some((c) => c.method === method)) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(f.calls().some((c) => c.method === method));
    controller.abort(new DOMException("Timed out", "TimeoutError"));
    await rejected;
  });
}

test("ACP listing reports spawn failures", async () => {
  const engine = new AcpEngine("absent", { command: "/does/not/exist", args: [] });
  await assert.rejects(engine.listSessions("/tmp"), /ENOENT/);
});


test("ACP listing includes newer sessions beyond the first ten entries", async (t) => {
  const f = fixture(t, "late-newest");
  const sessions = await f.engine.listSessions(f.cwd);
  assert.equal(sessions.length, 10);
  assert.equal(sessions[0].sessionId, "late-newest");
  assert.equal(f.calls().filter((c) => c.method === "session/list").length, 2);
});

// Exercise the user command with the real ACP fixture transport and isolated persistence.
test("/resume shows ACP titles, handles unknown activity and persists the selected session", async (t) => {
  const { Config } = await import("../src/config.js");
  const { Orchestrator } = await import("../src/orchestrator.js");
  const f = fixture(t, "missing");
  const previous = process.env.CLEARCLAW_HOME;
  process.env.CLEARCLAW_HOME = f.cwd;
  let config;
  try { config = new Config(); } finally {
    if (previous === undefined) delete process.env.CLEARCLAW_HOME;
    else process.env.CLEARCLAW_HOME = previous;
  }
  config.addUser({ id: "test:user", name: "Tester", approvedAt: 1 });
  config.upsertWorkspace({ name: "probe", chat_id: "test:resume", cwd: f.cwd, engine: "codex", current_session_id: null });
  const messages: string[] = [];
  const channel = {
    name: "test", ownsId: (id: string) => id.startsWith("test:"), isRootDM: () => false,
    sendMessage: async (_id: string, text: string) => { messages.push(text); return ["message"]; },
    sendInteractive: async (_id: string, text: string, buttons: Array<Array<{label: string; value: string}>>) => {
      assert.match(text, /Pick a session to resume:/);
      assert.match(text, /no-title\n   Unknown activity/);
      assert.equal(buttons[0][0].label, "1. Known date");
      return { value: buttons[0][0].value };
    },
  } as unknown as import("../src/types.js").Channel;
  const orchestrator = new Orchestrator({ config, channel, engines: new Map([["codex", f.engine]]) }) as unknown as {
    routeMessage(msg: import("../src/types.js").InboundMessage): Promise<void>;
  };
  await orchestrator.routeMessage({ chatId: "test:resume", chatType: "group", text: "/resume", origin: { kind: "user", user: { id: "test:user", name: "Tester" } } });
  assert.deepEqual(messages, ["Resumed session: Known date"]);
  assert.equal(config.workspaceByName("probe")?.current_session_id, "dated");
});
