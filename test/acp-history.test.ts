import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { AcpEngine } from "../src/engine/acp.js";

function fixture(t: TestContext, mode = "success") {
  const root = mkdtempSync(join(tmpdir(), "clearclaw-history-test-"));
  const log = join(root, "requests.jsonl");
  t.after(async () => {
    const pid = JSON.parse(readFileSync(log, "utf8").split("\n")[0]!).pid;
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch { rmSync(root, { recursive: true }); return; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("History adapter did not exit");
  });
  return {
    engine: new AcpEngine("fixture", {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/acp-history-agent.mjs", import.meta.url))],
      env: { HISTORY_MODE: mode, HISTORY_LOG: log },
    }),
    opts: { sessionId: "source-session", cwd: root },
    calls() { return readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)); },
  };
}

test("ACP history loads without prompting, preserves message IDs, joins chunks and excludes thoughts", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.engine.getSessionMessages(f.opts), [
    { role: "user", text: "Keep it simple." },
    { role: "user", text: "And readable." },
    { role: "assistant", text: "Plain markdown." },
    { role: "assistant", text: "Next answer." },
    { role: "user", text: "No IDs still join." },
  ]);
  assert.deepEqual(f.calls().filter((call) => call.method).map((call) => call.method), ["initialize", "session/load"]);
  assert.deepEqual(f.calls().find((call) => call.method === "session/load").params, { ...f.opts, mcpServers: [] });
});

for (const [mode, error] of [["unsupported", /does not support/], ["error", /Missing session/], ["exit", /exited|closed/]] as const) {
  test(`ACP history rejects ${mode} instead of reporting empty history`, async (t) => {
    const f = fixture(t, mode);
    await assert.rejects(f.engine.getSessionMessages(f.opts), error);
  });
}

test("ACP history aborts a stalled adapter and terminates its process", async (t) => {
  const f = fixture(t, "hang");
  const controller = new AbortController();
  const result = f.engine.getSessionMessages({ ...f.opts, signal: controller.signal });
  const rejection = assert.rejects(result, { name: "AbortError" });
  // Wait until the real child has received load before cancelling it.
  for (let i = 0; i < 100; i++) {
    try { if (f.calls().some((call) => call.method === "session/load")) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  controller.abort();
  await rejection;
  for (let i = 0; i < 100; i++) {
    if (f.calls().some((call) => call.stopped)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Adapter was not terminated after cancellation");
});

test("ACP history does not spawn for an already aborted request", async () => {
  const engine = new AcpEngine("absent", { command: "/does/not/exist", args: [] });
  await assert.rejects(engine.getSessionMessages({ sessionId: "id", cwd: "/tmp", signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("ACP history reports adapter spawn failures", async () => {
  const engine = new AcpEngine("absent", { command: "/does/not/exist", args: [] });
  await assert.rejects(engine.getSessionMessages({ sessionId: "id", cwd: "/tmp" }), /ENOENT/);
});

test("ACP history cancels permission requests while loading", async (t) => {
  const f = fixture(t, "permission");
  assert.deepEqual(await f.engine.getSessionMessages(f.opts), []);
  assert.ok(f.calls().some((call) => call.result?.outcome?.outcome === "cancelled"));
});
