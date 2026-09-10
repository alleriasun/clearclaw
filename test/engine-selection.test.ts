import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Config } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { ButtonResponse, Channel, Engine, InboundMessage, RunTurnOpts, TurnStats, Workspace } from "../src/types.js";

const chatId = "test:engine-selection";
interface Internals {
  chat(id: string): {
    busy: boolean;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    stats: TurnStats | null;
    engineName: string | null;
    permissionMode: RunTurnOpts["permissionMode"] | null;
  };
  routeMessage(message: InboundMessage): Promise<void>;
  processQueuedMessages(id: string): Promise<void>;
  updateStatusMessage(id: string, state: ReturnType<Internals["chat"]>): Promise<void>;
  buildMcpTools(id: string, behavior: string, state: object): Array<{
    name: string;
    handler(args: Record<string, unknown>): Promise<unknown>;
  }>;
}

function harness(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-engine-selection-"));
  const previousHome = process.env.CLEARCLAW_HOME;
  process.env.CLEARCLAW_HOME = root;
  let config: Config;
  try {
    config = new Config();
  } finally {
    if (previousHome === undefined) delete process.env.CLEARCLAW_HOME;
    else process.env.CLEARCLAW_HOME = previousHome;
  }
  config.defaultEngine = "claude-code";
  config.addUser({ id: "test:paddy", name: "Paddy", approvedAt: Date.now() });
  fs.mkdirSync(config.homeWorkspacePath, { recursive: true });
  const calls: Array<{ engine: string; opts: RunTurnOpts }> = [];
  const messages: string[] = [];
  const statuses: string[] = [];
  let statusHandler: () => Promise<void> = async () => {};
  let messageHandler: (text: string) => void = () => {};
  let picker: () => Promise<ButtonResponse> = async () => ({ value: "codex" });
  const channel = {
    name: "test",
    ownsId: (id: string) => id.startsWith("test:"),
    isRootDM: (id: string, userId: string) => id === userId,
    sendMessage: async (_id: string, text: string) => {
      messageHandler(text);
      messages.push(text);
      return ["message"];
    },
    sendInteractive: async () => picker(),
    updateStatus: async (_id: string, text: string) => {
      statuses.push(text);
      await statusHandler();
    },
    setTyping: async () => {},
    editMessage: async () => {},
    reactToMessage: async () => {},
  } as unknown as Channel;
  const engines = new Map<string, Engine>(["claude-code", "codex", "kiro"].map((name) => [name, {
    name,
    listSessions: async () => [],
    getSessionMessages: async () => [],
    async *runTurn(opts: RunTurnOpts) {
      calls.push({ engine: name, opts });
      if (name === "claude-code") throw new Error("Claude quota exhausted");
      yield { type: "done" as const, sessionId: "codex-session" };
    },
  }]));
  const orchestrator = new Orchestrator({ config, channel, engines });
  const internals = orchestrator as unknown as Internals;
  t.after(() => {
    const state = internals.chat(chatId);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const route = (text: string, userId = "test:paddy") => internals.routeMessage({
    chatId, chatType: "group", text,
    origin: { kind: "user", user: { id: userId, name: "Paddy" } },
  });
  return {
    config, internals, calls, messages, statuses, route,
    onStatus: (fn: () => Promise<void>) => { statusHandler = fn; },
    onMessage: (fn: (text: string) => void) => { messageHandler = fn; },
    runTurn: (name: string, run: Engine["runTurn"]) => {
      engines.get(name)!.runTurn = (opts) => {
        calls.push({ engine: name, opts });
        return run(opts);
      };
    },
    picker: (fn: () => Promise<ButtonResponse>) => { picker = fn; },
    workspace: (overrides: Partial<Workspace> = {}) => {
      const ws: Workspace = {
        name: "engine-selection", chat_id: chatId, cwd: config.homeWorkspacePath,
        current_session_id: "claude-session", engine: "claude-code", model: "claude-opus",
        ...overrides,
      };
      config.upsertWorkspace(ws);
      return ws;
    },
    drain: async () => {
      const state = internals.chat(chatId);
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
      await internals.processQueuedMessages(chatId);
    },

  };
}

test("workspace switch clears engine-specific session and model before the next turn", async (t) => {
  const h = harness(t);
  h.workspace();
  await h.route("/engine codex");
  const saved = h.config.workspaceByChat(chatId)!;
  assert.equal(saved.engine, "codex");
  assert.equal(saved.current_session_id, null);
  assert.equal(saved.model, undefined);
  assert.equal(h.calls.length, 0);
  await h.route("Continue");
  await h.drain();
  assert.equal(h.calls[0].engine, "codex");
  assert.equal(h.calls[0].opts.sessionId, null);
  assert.equal(h.calls[0].opts.model, undefined);
});

for (const command of ["/engine missing", "/engine claude-code"]) {
  test(`${command} preserves the existing workspace session and model`, async (t) => {
    const h = harness(t);
    const original = h.workspace();
    await h.route(command);
    assert.deepEqual(h.config.workspaceByChat(chatId), original);
    assert.equal(h.calls.length, 0);
  });
}

test("unknown picker values cannot become a configured engine", async (t) => {
  const h = harness(t);
  const original = h.workspace();
  h.picker(async () => ({ value: "missing" }));
  await h.route("/engine");
  assert.deepEqual(h.config.workspaceByChat(chatId), original);
});

test("picker cannot switch engines after a turn starts", async (t) => {
  const h = harness(t);
  const original = h.workspace();
  h.picker(async () => {
    h.internals.chat(chatId).busy = true;
    return { value: "codex" };
  });
  await h.route("/engine");
  assert.deepEqual(h.config.workspaceByChat(chatId), original);
  assert.match(h.messages.join("\n"), /\/cancel/);
});

for (const command of ["/engine codex", "/new"]) {
  test(`${command} confirms saved changes before a slow status update finishes`, { timeout: 1000 }, async (t) => {
    const h = harness(t);
    h.workspace();
    let configAtConfirmation: Workspace | undefined;
    h.onMessage(() => { configAtConfirmation = h.config.workspaceByChat(chatId); });
    let started!: () => void;
    const statusStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const statusBlocked = new Promise<void>((resolve) => { release = resolve; });
    h.onStatus(async () => {
      started();
      await statusBlocked;
    });
    const routed = h.route(command);
    try {
      await statusStarted;
      assert.match(h.messages.join("\n"), command === "/new" ? /Session cleared/ : /Engine set to codex/);
      assert.ok(configAtConfirmation);
      assert.equal(configAtConfirmation.current_session_id, null);
      if (command === "/engine codex") {
        assert.equal(configAtConfirmation.engine, "codex");
        assert.equal(configAtConfirmation.model, undefined);
      }
      assert.equal(h.calls.length, 0);
    } finally {
      release();
      await routed;
    }
  });
}

test("unknown context usage shows the engine and usage n/a instead of a fabricated percentage", async (t) => {
  const h = harness(t);
  const state = h.internals.chat(chatId);
  state.engineName = "codex";
  state.stats = { model: null, contextUsed: 0, contextWindow: 0, toolCalls: {} };
  await h.internals.updateStatusMessage(chatId, state);
  assert.match(h.statuses[0], /codex/);
  assert.match(h.statuses[0], /usage n\/a/i);
  assert.doesNotMatch(h.statuses[0], /\d+%/);
});

for (const used of [0, 250]) {
  test(`measured context usage ${used}/1000 retains its percentage`, async (t) => {
    const h = harness(t);
    const state = h.internals.chat(chatId);
    state.engineName = "claude-code";
    state.stats = { model: "claude-opus", contextUsed: used, contextWindow: 1000, toolCalls: {} };
    await h.internals.updateStatusMessage(chatId, state);
    assert.match(h.statuses[0], new RegExp(` ${used / 10}%`));
    assert.doesNotMatch(h.statuses[0], /usage n\/a/i);
  });
}

for (const engine of ["codex", "kiro"]) {
test(`${engine} /model saves a choice and passes it to the existing session's next turn`, async (t) => {
  const h = harness(t);
  h.workspace({ engine, current_session_id: "existing-codex", model: undefined });
  await h.route("/model chosen-model");
  assert.equal(h.calls.length, 0);
  assert.match(h.messages.join("\n"), /Model set to chosen-model/);
  assert.equal(h.config.workspaceByChat(chatId)?.model, "chosen-model");
  assert.equal(h.config.workspaceByChat(chatId)?.current_session_id, "existing-codex");
  await h.route("Continue");
  await h.drain();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].engine, engine);
  assert.equal(h.calls[0].opts.model, "chosen-model");
  assert.equal(h.calls[0].opts.sessionId, "existing-codex");
});

}

for (const model of [undefined, "chosen-model"]) {
  test(`Codex /model reports ${model ? "the configured override" : "no configured override"} without running an engine`, async (t) => {
    const h = harness(t);
    h.workspace({ engine: "codex", model });
    await h.route("/model");
    assert.match(h.messages.join("\n"), model ? /Saved model: chosen-model/ : /No model override set/);
    assert.equal(h.calls.length, 0);
  });
}

test("a model chosen during a turn survives late session events reporting the old model", async (t) => {
  const h = harness(t);
  h.workspace({ engine: "codex", current_session_id: "existing-codex", model: "old-model" });
  let busyAtSelection = false;
  h.runTurn("codex", async function* () {
    busyAtSelection = h.internals.chat(chatId).busy;
    await h.route("/model chosen-model");
    yield { type: "session", sessionId: "existing-codex", model: "old-resolved-model" };
    yield { type: "done", sessionId: "existing-codex" };
  });
  await h.route("Continue");
  await h.drain();
  assert.equal(busyAtSelection, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].opts.model, "old-model");
  assert.equal(h.config.workspaceByChat(chatId)?.model, "chosen-model");
  h.runTurn("codex", async function* () {
    yield { type: "done", sessionId: "existing-codex" };
  });
  await h.route("Use my new model");
  await h.drain();
  assert.equal(h.calls[1].opts.model, "chosen-model");
  assert.equal(h.calls[1].opts.sessionId, "existing-codex");
});

for (const engine of ["claude-code", "codex"]) {
  test(`${engine} resolved session model does not become a configured override`, async (t) => {
    const h = harness(t);
    h.workspace({ engine, model: undefined });
    h.runTurn(engine, async function* () {
      yield { type: "session", sessionId: "resolved-session", model: "resolved-model" };
      yield { type: "done", sessionId: "resolved-session" };
    });
    await h.route("Continue");
    await h.drain();
    assert.equal(h.calls.length, 1);
    assert.equal(h.config.workspaceByChat(chatId)?.current_session_id, "resolved-session");
    assert.equal(h.config.workspaceByChat(chatId)?.model, undefined);
  });
}

test("a failed status update cannot turn successful engine selection into an internal error", async (t) => {
  const h = harness(t);
  h.workspace();
  h.onStatus(async () => { throw new Error("Status service unavailable"); });
  await h.route("/engine codex");
  assert.match(h.messages.join("\n"), /Engine set to codex/);
  assert.doesNotMatch(h.messages.join("\n"), /Internal error/);
  assert.equal(h.config.workspaceByChat(chatId)?.engine, "codex");
  assert.equal(h.config.workspaceByChat(chatId)?.current_session_id, null);
  h.onStatus(async () => {});
  await h.internals.updateStatusMessage(chatId, h.internals.chat(chatId));
  assert.equal(h.statuses.length, 2, "failed status was not cached as delivered");
});

for (const engine of ["claude-code", "codex"]) {
  test(`${engine} /model default clears the override but preserves the session and ignores late resolved models`, async (t) => {
    const h = harness(t);
    h.workspace({ engine, model: "old-model", current_session_id: "existing-session" });
    await h.route("/model default");
    assert.equal(h.calls.length, 0);
    assert.equal(h.config.workspaceByChat(chatId)?.model, undefined);
    assert.equal(h.config.workspaceByChat(chatId)?.current_session_id, "existing-session");
    assert.match(h.messages.join("\n"), /\/new/);
    h.runTurn(engine, async function* () {
      yield { type: "session", sessionId: "existing-session", model: "old-resolved-model" };
      yield { type: "done", sessionId: "existing-session" };
    });
    await h.route("Continue");
    await h.drain();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].opts.model, undefined);
    assert.equal(h.calls[0].opts.sessionId, "existing-session");
    assert.equal(h.config.workspaceByChat(chatId)?.model, undefined);
  });
}

test("/model default can clear an override for an engine without model selection support", async (t) => {
  const h = harness(t);
  h.workspace({ engine: "kiro", model: "stale-model", current_session_id: "existing-session" });
  await h.route("/model default");
  assert.equal(h.config.workspaceByChat(chatId)?.model, undefined);
  assert.equal(h.config.workspaceByChat(chatId)?.current_session_id, "existing-session");
  assert.doesNotMatch(h.messages.join("\n"), /isn't supported|Internal error/);
  assert.equal(h.calls.length, 0);
});

for (const previousValue of [undefined, "legacy-resolved-model"]) {
  test(`legacy config preserves ${previousValue ? "its saved model" : "engine defaults"} until explicitly changed`, async (t) => {
    const h = harness(t);
    const file = path.join(h.config.homeWorkspacePath, "..", "config.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.workspaces = [{ name: "legacy", chat_id: chatId, cwd: h.config.homeWorkspacePath,
      engine: "claude-code", current_session_id: "legacy-session", model: previousValue }];
    fs.writeFileSync(file, JSON.stringify(data));
    const beforeRead = fs.readFileSync(file, "utf8");
    await h.route("/model");
    assert.equal(fs.readFileSync(file, "utf8"), beforeRead, "reading does not migrate or rewrite the saved config");
    assert.match(h.messages.at(-1)!, previousValue ? /Saved model: legacy-resolved-model/ : /No model override set/);
    h.runTurn("claude-code", async function* () {
      yield { type: "session", sessionId: "legacy-session", model: "new-reported-model" };
      yield { type: "done", sessionId: "legacy-session" };
    });
    await h.route("Continue");
    await h.drain();
    assert.equal(h.calls[0].opts.model, previousValue);
    assert.equal(h.config.workspaceByChat(chatId)?.model, previousValue);
    await h.route("/model default");
    await h.route("Continue with defaults");
    await h.drain();
    assert.equal(h.calls[1].opts.model, undefined);
    assert.equal(h.config.workspaceByChat(chatId)?.model, undefined);
  });
}
