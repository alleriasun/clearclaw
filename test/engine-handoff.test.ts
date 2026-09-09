import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Config } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { assemblePrompt } from "../src/prompt.js";
import type { Channel, Engine, InboundMessage, RunTurnOpts, SessionHistoryOpts, Workspace } from "../src/types.js";

const chatId = "test:handoff";
const oldSession = "old-legacy-session-for-handoff-test";
interface Handoff { engine: string; sessionId: string; cwd: string }
interface Task { sessionId: string | null; engine?: string; cwd: string; prompt: string; engine_handoff?: Handoff }
interface Internals {
  deliverToWorkspace(name: string, origin: InboundMessage["origin"], text: string): boolean;
  tasks: Map<string, Task>;
  chat(id: string): { debounceTimer: ReturnType<typeof setTimeout> | null };
  routeMessage(msg: InboundMessage): Promise<void>;
  processQueuedMessages(id: string): Promise<void>;
  buildMcpTools(id: string, behavior: string, state: object): Array<{
    name: string;
    handler(args: Record<string, unknown>): Promise<unknown>;
  }>;
}

function harness(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-handoff-test-"));
  const makeConfig = () => {
    const previous = process.env.CLEARCLAW_HOME;
    process.env.CLEARCLAW_HOME = root;
    try {
      const config = new Config();
      config.defaultEngine = "legacy-test";
      return config;
    } finally {
      if (previous === undefined) delete process.env.CLEARCLAW_HOME;
      else process.env.CLEARCLAW_HOME = previous;
    }
  };
  const config = makeConfig();
  config.addUser({ id: "test:user", name: "Tester", approvedAt: 1 });
  fs.mkdirSync(config.homeWorkspacePath, { recursive: true });
  const messages: string[] = [];
  const calls: Array<{ engine: string; opts: RunTurnOpts }> = [];
  const historyCalls: Array<{ engine: string; opts: SessionHistoryOpts }> = [];
  const channel = {
    name: "test", ownsId: (id: string) => id.startsWith("test:"),
    sendMessage: async (_id: string, text: string) => { messages.push(text); return ["message"]; },
    sendInteractive: async () => ({ value: "resumed-session" }),
    updateStatus: async () => {}, setTyping: async () => {}, editMessage: async () => {},
  } as unknown as Channel;
  const engines = new Map<string, Engine>(["legacy-test", "codex", "claude-code"].map((name) => [name, {
    name,
    listSessions: async () => [{ sessionId: "resumed-session", summary: "Selected session", lastModified: 1 }],
    getSessionMessages: async (opts: SessionHistoryOpts) => {
      historyCalls.push({ engine: name, opts });
      return [
        { role: "user" as const, text: "Keep the design in plain markdown." },
        { role: "assistant" as const, text: "We chose markdown files for the first version." },
      ];
    },
    async *runTurn(opts: RunTurnOpts) {
      calls.push({ engine: name, opts });
      yield { type: "done" as const, sessionId: "new-engine-session" };
    },
  }]));
  let internals = new Orchestrator({ config, channel, engines }) as unknown as Internals;
  const clearTimer = () => {
    const state = internals.chat(chatId);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  };
  t.after(() => { clearTimer(); fs.rmSync(root, { recursive: true, force: true }); });
  const route = (text: string) => internals.routeMessage({
    chatId, chatType: "group", text,
    origin: { kind: "user", user: { id: "test:user", name: "Tester" } },
  });
  return {
    config, messages, calls, historyCalls,
    history: (name: string, read: Engine["getSessionMessages"]) => { engines.get(name)!.getSessionMessages = read; },
    get internals() { return internals; },
    route,
    turn: async (text: string) => { await route(text); clearTimer(); await internals.processQueuedMessages(chatId); },
    automatedTurn: async (origin: InboundMessage["origin"]) => {
      assert.equal(internals.deliverToWorkspace("handoff", origin, "Run the automated task"), true);
      clearTimer();
      await internals.processQueuedMessages(chatId);
    },
    restart: () => { clearTimer(); internals = new Orchestrator({ config: makeConfig(), channel, engines }) as unknown as Internals; },
    workspace: (overrides: Partial<Workspace> = {}) => config.upsertWorkspace({
      name: "handoff", chat_id: chatId, cwd: config.homeWorkspacePath, engine: "legacy-test",
      current_session_id: oldSession, ...overrides,
    }),
    saved: () => config.workspaceByChat(chatId)! as Workspace & { engine_handoff?: Handoff },
    run: (name: string, run: Engine["runTurn"]) => {
      engines.get(name)!.runTurn = (opts) => { calls.push({ engine: name, opts }); return run(opts); };
    },
  };
}

test("engine handoff survives restart, enters only the ordinary prompt, and is consumed after success", async (t) => {
  const h = harness(t);
  h.workspace();
  await h.route("/engine codex");
  assert.deepEqual(h.saved().engine_handoff, { engine: "legacy-test", sessionId: oldSession, cwd: h.config.homeWorkspacePath });
  assert.equal(h.saved().current_session_id, null);
  h.restart();
  await h.turn("Continue the previous design discussion");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].engine, "codex");
  assert.equal(h.calls[0].opts.sessionId, null);
  assert.ok(h.calls[0].opts.prompt.includes(oldSession));
  assert.match(h.calls[0].opts.prompt, /legacy-test/);
  assert.match(h.calls[0].opts.prompt, /Continue the previous design discussion/);
  assert.equal(h.calls[0].opts.appendSystemPrompt, (await assemblePrompt(h.config.frameworkPromptDir, h.config.instructionsDir)).prompt);
  assert.equal(h.saved().engine_handoff, undefined);
  await h.turn("Next question");
  assert.equal(h.calls[1].opts.sessionId, "new-engine-session");
  assert.equal(h.calls[1].opts.prompt.includes(oldSession), false);
});

for (const scenario of [
  { name: "same engine", session: oldSession, command: "/engine legacy-test" },
  { name: "no previous session", session: null, command: "/engine codex" },
]) {
  test(`${scenario.name} does not create a handoff`, async (t) => {
    const h = harness(t);
    h.workspace({ current_session_id: scenario.session });
    await h.route(scenario.command);
    assert.equal(h.saved().engine_handoff, undefined);
    assert.equal(h.saved().current_session_id, scenario.session);
  });
}

test("chained engine changes retain the original session reference", async (t) => {
  const h = harness(t);
  h.workspace();
  await h.route("/engine codex");
  const original = h.saved().engine_handoff;
  await h.route("/engine claude-code");
  assert.deepEqual(h.saved().engine_handoff, original);
  await h.turn("Continue");
  assert.equal(h.calls[0].engine, "claude-code");
  assert.ok(h.calls[0].opts.prompt.includes(oldSession));
});

test("an early session followed by failure retains handoff for the next attempt", async (t) => {
  const h = harness(t);
  h.workspace();
  await h.route("/engine codex");
  h.run("codex", async function* () {
    yield { type: "session", sessionId: "partial-session" };
    throw new Error("Simulated quota failure");
  });
  await h.turn("Continue");
  assert.equal(h.saved().current_session_id, "partial-session");
  assert.equal(h.saved().engine_handoff?.sessionId, oldSession);
  h.run("codex", async function* () { yield { type: "done", sessionId: "partial-session" }; });
  await h.turn("Try again");
  assert.equal(h.calls[1].opts.sessionId, "partial-session");
  assert.ok(h.calls[1].opts.prompt.includes(oldSession));
  assert.equal(h.saved().engine_handoff, undefined);
});

test("a cancelled turn cannot consume handoff even if the engine emits done", async (t) => {
  const h = harness(t);
  h.workspace();
  await h.route("/engine codex");
  h.run("codex", async function* () {
    yield { type: "session", sessionId: "cancelled-session" };
    await h.route("/cancel");
    yield { type: "done", sessionId: "cancelled-session" };
  });
  await h.turn("Continue");
  assert.equal(h.saved().engine_handoff?.sessionId, oldSession);
});

for (const command of ["/new", "/resume"]) {
  test(`${command} explicitly discards pending handoff`, async (t) => {
    const h = harness(t);
    h.workspace();
    await h.route("/engine codex");
    await h.route(command);
    assert.equal(h.saved().engine_handoff, undefined);
    await h.turn("Start here");
    assert.equal(h.calls[0].opts.prompt.includes(oldSession), false);
    assert.equal(h.calls[0].opts.sessionId, command === "/new" ? null : "resumed-session");
  });
}

test("onboarding task switches carry context without changing setup instructions", async (t) => {
  const h = harness(t);
  const task: Task = { sessionId: oldSession, engine: "legacy-test", cwd: h.config.homeWorkspacePath, prompt: "Original setup instructions" };
  h.internals.tasks.set(chatId, task);
  await h.route("/engine codex");
  assert.equal(task.engine_handoff?.sessionId, oldSession);
  assert.equal(task.sessionId, null);
  await h.turn("Finish setup");
  assert.ok(h.calls[0].opts.prompt.includes(oldSession));
  assert.match(h.calls[0].opts.prompt, /Finish setup/);
  assert.equal(task.prompt, "Original setup instructions");
  assert.equal(task.engine_handoff, undefined);
});

test("a pass-through slash command neither receives nor consumes pending context", async (t) => {
  const h = harness(t);
  h.workspace();
  await h.route("/engine codex");
  await h.turn("/compact");
  assert.equal(h.calls[0].opts.prompt, "/compact");
  assert.equal(h.saved().engine_handoff?.sessionId, oldSession);
  await h.turn("Continue the discussion");
  assert.ok(h.calls[1].opts.prompt.includes(oldSession));
  assert.equal(h.saved().engine_handoff, undefined);
});

test("an error event followed by done cannot consume handoff", async (t) => {
  const h = harness(t);
  h.workspace();
  await h.route("/engine codex");
  h.run("codex", async function* () {
    yield { type: "error", message: "Quota exhausted" };
    yield { type: "done", sessionId: "failed-session" };
  });
  await h.turn("Continue");
  assert.equal(h.calls.length, 1);
  assert.equal(h.saved().engine_handoff?.sessionId, oldSession);
});

test("the source engine supplies normalized history once, regardless of engine name", async (t) => {
  const h = harness(t);
  const sessionId = "opaque-provider-session-id";
  h.workspace({ engine: "legacy-test", current_session_id: sessionId });
  await h.route("/engine claude-code");
  await h.turn("Continue with that design.");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].engine, "claude-code");
  assert.equal(h.historyCalls.length, 1);
  assert.equal(h.historyCalls[0].engine, "legacy-test");
  assert.equal(h.historyCalls[0].opts.sessionId, sessionId);
  assert.equal(h.historyCalls[0].opts.cwd, h.config.homeWorkspacePath);
  assert.ok(h.historyCalls[0].opts.signal instanceof AbortSignal);
  assert.equal(h.calls[0].opts.sessionId, null);
  assert.ok(h.calls[0].opts.prompt.includes(sessionId));
  assert.ok(h.calls[0].opts.prompt.includes("User:\nKeep the design in plain markdown."));
  assert.ok(h.calls[0].opts.prompt.includes("Assistant:\nWe chose markdown files for the first version."));
  assert.ok(h.calls[0].opts.prompt.includes("Continue with that design."));
  assert.equal(h.calls[0].opts.appendSystemPrompt, (await assemblePrompt(h.config.frameworkPromptDir, h.config.instructionsDir)).prompt);
  await h.turn("Next question.");
  assert.equal(h.historyCalls.length, 1);
  assert.equal(h.calls[1].opts.prompt.includes(sessionId), false);
  assert.equal(h.calls[1].opts.prompt.includes("Keep the design in plain markdown."), false);
  t.diagnostic(JSON.stringify({
    receivedBy: h.calls[0].engine, resumedSession: h.calls[0].opts.sessionId,
    receivedPrompt: h.calls[0].opts.prompt, handoffRepeatedOnNextTurn: false,
  }));
});


test("history retrieval failure falls back to session reference and still runs the target", async (t) => {
  const h = harness(t);
  h.workspace();
  h.history("legacy-test", async () => { throw new Error("Replay unavailable"); });
  await h.route("/engine codex");
  await h.turn("Continue");
  assert.match(h.calls[0].opts.prompt, /Transcript unavailable/);
  assert.ok(h.calls[0].opts.prompt.includes(oldSession));
  assert.equal(h.saved().engine_handoff, undefined);
});

test("cancellation during history retrieval prevents the target turn and keeps the handoff", async (t) => {
  const h = harness(t);
  h.workspace();
  h.history("legacy-test", async ({ signal }) => {
    await h.route("/cancel");
    signal!.throwIfAborted();
    return [];
  });
  await h.route("/engine codex");
  await h.turn("Continue");
  assert.equal(h.calls.length, 0);
  assert.equal(h.saved().engine_handoff?.sessionId, oldSession);
});

for (const origin of [
  { kind: "scheduler" as const, scheduleId: "test-schedule" },
  { kind: "peer" as const, workspaceName: "test-peer" },
]) {
  test(`${origin.kind} delivery leaves history pending until a user continuation`, async (t) => {
    const h = harness(t);
    h.workspace();
    await h.route("/engine codex");
    await h.automatedTurn(origin);
    assert.equal(h.historyCalls.length, 0);
    assert.equal(h.calls[0].opts.prompt.includes(oldSession), false);
    assert.equal(h.saved().engine_handoff?.sessionId, oldSession);
    await h.turn("Continue our discussion");
    assert.equal(h.historyCalls.length, 1);
    assert.equal(h.calls[1].opts.sessionId, "new-engine-session");
    assert.ok(h.calls[1].opts.prompt.includes(oldSession));
    assert.equal(h.saved().engine_handoff, undefined);
  });
}
