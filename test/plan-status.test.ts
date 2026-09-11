import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { Config } from "../src/config.js";
import { AcpEngine } from "../src/engine/acp.js";
import { CLAUDE_PLAN_WINDOWS, claudePlanUsage } from "../src/engine/claude-code.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { Channel, Engine, EngineEvent, InboundMessage, Workspace } from "../src/types.js";

interface Internals {
  chat(id: string): object;
  executeTurn(id: string, messages: InboundMessage[], workspace: Workspace, state: object): Promise<void>;
}

function harness(t: TestContext, acpFixture?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-plan-status-"));
  const previousHome = process.env.CLEARCLAW_HOME;
  process.env.CLEARCLAW_HOME = root;
  let config: Config;
  try { config = new Config(); }
  finally {
    if (previousHome === undefined) delete process.env.CLEARCLAW_HOME;
    else process.env.CLEARCLAW_HOME = previousHome;
  }
  config.defaultEngine = "claude-code";
  const messages: Array<{ id: string; text: string }> = [];
  const statuses: Array<{ id: string; text: string }> = [];
  const releases: Array<() => void> = [];
  let beforeDone = async () => {};
  const channel = {
    name: "test", ownsId: () => true,
    statusMaxLength: 250,
    sendMessage: async (id: string, text: string) => { messages.push({ id, text }); return ["message"]; },
    updateStatus: async (id: string, text: string) => { statuses.push({ id, text }); },
    setTyping: async () => {}, editMessage: async () => {}, disconnect: async () => {},
  } as unknown as Channel;
  const scripts = new Map<string, EngineEvent[]>();
  const engines = new Map<string, Engine>(["claude-code", "codex"].map((name) => [name, {
    name, planUsageWindows: name === "claude-code" ? CLAUDE_PLAN_WINDOWS : undefined, listSessions: async () => [], getSessionMessages: async () => [],
    async *runTurn() {
      yield* scripts.get(name) ?? [];
      await beforeDone();
      yield { type: "done" as const, sessionId: `${name}-session`, stats: {
        model: name === "claude-code" ? "claude-fable-5" : name,
        modelLabel: name === "claude-code" ? "fable-5" : name, contextUsed: 130, contextWindow: 1000, toolCalls: {},
      } };
    },
  }]));
  if (acpFixture) engines.set("codex", new AcpEngine("codex", {
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/acp-model-agent.mjs", import.meta.url)), acpFixture, path.join(root, "acp.jsonl")],
  }));
  const orchestrator = new Orchestrator({ config, channel, engines });
  const internals = orchestrator as unknown as Internals;
  t.after(async () => {
    for (const release of releases) release();
    await orchestrator.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    messages, statuses, releases,
    mode: (id: string, permissionMode: "plan") => Object.assign(internals.chat(id), { permissionMode }),
    beforeDone: (handler: typeof beforeDone) => { beforeDone = handler; },
    latest: (id: string) => statuses.filter((entry) => entry.id === id).at(-1)?.text ?? "",
    workspace: (id: string, engine: string) => {
      config.upsertWorkspace({ name: id, chat_id: id, cwd: root, engine, current_session_id: null });
      internals.chat(id);
    },
    turn: async (id: string, events: EngineEvent[] = []) => {
      const workspace = config.workspaceByChat(id)!;
      scripts.set(workspace.engine!, events);
      await internals.executeTurn(id, [{
        chatId: id, chatType: "group", text: "Continue",
        origin: { kind: "user", user: { id: "test:user", name: "Tester" } },
      }], workspace, internals.chat(id));
    },
  };
}

const codexUsage = (usedPercent: number): EngineEvent => ({
  type: "plan_usage", windows: [{ id: "codex/primary", label: "5h", usedPercent }],
});

test("ACP session models reach the status beside context and account usage", async (t) => {
  const h = harness(t, "quota");
  h.workspace("codex", "codex");
  await h.turn("codex");
  assert.equal(h.latest("codex"), "🤖 default-model 25% | codex | 5h 47%, 7d 18%");
  t.diagnostic(`New session: ${h.latest("codex")}`);
  await h.turn("codex");
  assert.equal(h.latest("codex"), "🤖 resumed-model 25% | codex | 5h 47%, 7d 18%");
  t.diagnostic(`Resumed session: ${h.latest("codex")}`);

  const unknown = harness(t, "no-config");
  unknown.workspace("codex", "codex");
  await unknown.turn("codex");
  assert.equal(unknown.latest("codex"), "🤖 usage n/a | codex");
  t.diagnostic(`Unknown model: ${unknown.latest("codex")}`);
});

test("allowed Claude events update plan usage without warning or replacing context usage", async (t) => {
  const h = harness(t);
  h.workspace("claude", "claude-code");
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  await h.turn("claude", [claudePlanUsage({ status: "allowed", unifiedWindows: {
    five_hour: { utilization: .42, resetsAt },
    seven_day: { utilization: .25, resetsAt },
    seven_day_overage_included: { utilization: .5, resetsAt },
  } })]);
  assert.match(h.latest("claude"), /fable-5 13%/);
  assert.doesNotMatch(h.latest("claude"), /claude-fable|ctx|used:|🔒/);
  assert.match(h.latest("claude"), /\| claude-code \| 5h 42%/);
  assert.match(h.latest("claude"), /7d 25%/);
  assert.match(h.latest("claude"), /Fable 7d 50%/);
  assert.equal(h.messages.filter(({ text }) => /rate limit|warning/i.test(text)).length, 0);

  await h.turn("claude", [claudePlanUsage({ status: "allowed", rateLimitType: "five_hour" })]);
  // An "allowed" event with no utilization clears the reading, so the window drops
  // out rather than showing a stale percentage or a bare "?".
  assert.doesNotMatch(h.latest("claude"), /5h/);
  assert.doesNotMatch(h.latest("claude"), /42%/);
});

test("workspaces read shared account usage on their own next turn completion", async (t) => {
  const h = harness(t);
  h.workspace("codex-a", "codex");
  h.workspace("codex-b", "codex");
  h.workspace("claude", "claude-code");
  await h.turn("codex-a");
  await h.turn("codex-b");
  await h.turn("claude", [claudePlanUsage({ status: "allowed", rateLimitType: "five_hour", utilization: 0.32 })]);
  const claudeStatus = h.latest("claude");
  await h.turn("codex-a", [codexUsage(71)]);
  assert.match(h.latest("codex-a"), /5h 71%/);
  assert.doesNotMatch(h.latest("codex-b"), /71%/);
  await h.turn("codex-b");
  assert.match(h.latest("codex-b"), /5h 71%/);
  assert.equal(h.latest("claude"), claudeStatus);
  assert.doesNotMatch(h.latest("claude"), /71%/);
});

test("quota events leave the status unchanged until the turn completes", async (t) => {
  const h = harness(t);
  h.workspace("codex", "codex");
  await h.turn("codex", [codexUsage(20)]);
  const previous = h.latest("codex");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  h.releases.push(release);
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  h.beforeDone(async () => { began(); await blocked; });
  const turn = h.turn("codex", [codexUsage(50)]);
  await started;
  assert.equal(h.latest("codex"), previous);
  t.diagnostic(`During turn: ${h.latest("codex")}`);
  release();
  await turn;
  assert.match(h.latest("codex"), /5h 50%/);
  t.diagnostic(`After completion: ${h.latest("codex")}`);
});

test("Claude quota is informational while actual turn errors remain visible", async (t) => {
  const h = harness(t);
  h.workspace("claude", "claude-code");
  await h.turn("claude", [claudePlanUsage({ status: "rejected", rateLimitType: "five_hour" }),
    { type: "error", message: "You're out of usage credits" }]);
  assert.equal(h.messages.filter(({ text }) => /Rate limited/.test(text)).length, 0);
  assert.equal(h.messages.filter(({ text }) => /You're out of usage credits/.test(text)).length, 1);
  assert.match(h.latest("claude"), /5h limited/);
});

test("many quota windows fit the channel limit with context, model, mode and explicit omissions", async (t) => {
  const h = harness(t);
  h.workspace("codex", "codex");
  h.mode("codex", "plan");
  await h.turn("codex", [{ type: "plan_usage", windows: [
    { id: "codex/primary", label: "5h", usedPercent: 71 },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `bucket-${index}/secondary`, label: `codex-special-${index} 7d`, usedPercent: 43,
      resetsAt: Math.floor(Date.now() / 1000) + 604800,
    })),
  ] }]);
  const status = h.latest("codex");
  assert.ok(status.length <= 250, `full status exceeds the topic limit: ${status.length}`);
  assert.match(status, /codex 13%/);
  assert.match(status, /🔒 Plan \|/);
  assert.match(status, /5h 71%/);
  assert.match(status, /\+[1-9]\d* more$/);
});
