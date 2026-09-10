import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Config } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { Channel, Engine, InboundMessage, RunTurnOpts } from "../src/types.js";

interface Tool {
  name: string;
  handler(args: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }>;
}
interface Internals {
  routeMessage(msg: InboundMessage): Promise<void>;
  processQueuedMessages(chatId: string): Promise<void>;
  chats: Map<string, { debounceTimer: ReturnType<typeof setTimeout> | null; messageQueue: InboundMessage[] }>;
  buildMcpTools(chatId: string, behavior: string, state: object): Tool[];
}

function harness(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-bootstrap-"));
  const previousHome = process.env.CLEARCLAW_HOME;
  process.env.CLEARCLAW_HOME = root;
  const config = new Config();
  if (previousHome === undefined) delete process.env.CLEARCLAW_HOME;
  else process.env.CLEARCLAW_HOME = previousHome;
  config.defaultEngine = "codex";
  config.approveUser("tg:123", "Owner");
  const messages: Array<{ chatId: string; text: string }> = [];
  const calls: RunTurnOpts[] = [];
  const created: Array<{ project: string; anchor: string; name: string }> = [];
  let topic = 70;
  let interactive = "spawn";
  const channel = {
    name: "telegram", ownsId: (id: string) => id.startsWith("tg:"),
    isRootDM: (id: string, userId: string) => /^tg:[1-9]\d*$/.test(id) && id === userId,
    connect: async () => {}, disconnect: async () => {}, on: () => {},
    sendMessage: async (chatId: string, text: string) => { messages.push({ chatId, text }); return ["1"]; },
    sendInteractive: async () => ({ value: interactive }),
    createProjectChat: async (project: string, anchor: string, name: string) => {
      created.push({ project, anchor, name }); return `tg:123:${++topic}`;
    },
    closeProjectChat: async () => {}, setupProject: async () => {},
    setTyping: async () => {}, updateStatus: async () => {}, editMessage: async () => {},
  } as unknown as Channel;
  const engine: Engine = {
    name: "codex", getSessionMessages: async () => [], listSessions: async () => [],
    async *runTurn(opts: RunTurnOpts) {
      calls.push(opts);
      yield { type: "done" as const, sessionId: "new-session" };
    },
  };
  const engines = new Map<string, Engine>([["codex", engine]]);
  let orchestrator = new Orchestrator({ config, channel, engines });
  let internals = orchestrator as unknown as Internals;
  const signals = ["SIGINT", "SIGTERM"] as const;
  const listeners = signals.map((signal) => new Set(process.listeners(signal)));
  const clearTimers = () => { for (const state of internals.chats.values()) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  } };
  t.after(async () => {
    clearTimers(); await orchestrator.stop();
    signals.forEach((signal, i) => { for (const listener of process.listeners(signal)) {
      if (!listeners[i].has(listener)) process.removeListener(signal, listener);
    } });
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, config, channel, engine, calls, messages, created,
    press: (value: string) => { interactive = value; },
    start: () => orchestrator.start(),
    restart: async () => {
      clearTimers(); await orchestrator.stop();
      orchestrator = new Orchestrator({ config, channel, engines });
      internals = orchestrator as unknown as Internals;
      await orchestrator.start();
    },
    route: (chatId: string, text: string, userId = "tg:123", chatType: "dm" | "group" = "group") =>
      internals.routeMessage({ chatId, text, chatType, origin: { kind: "user", user: { id: userId, name: "Owner" } } }),
    drain: async (chatId: string) => { clearTimers(); await internals.processQueuedMessages(chatId); },
    tool: (name: string, chatId = "tg:123") => {
      const tool = internals.buildMcpTools(chatId, "assistant", { staySilent: false, replyToMessageId: null }).find((tool) => tool.name === name);
      assert.ok(tool, name); return tool;
    },
  };
}

test("startup creates home without a chat; an authorized root DM starts a normal session", async (t) => {
  const h = harness(t);
  await h.start();
  assert.equal(h.config.workspaceByName("default")?.chat_id, null);
  assert.equal(h.config.projectByName("home")?.main_workspace, "default");
  assert.equal(h.calls.length, 0);
  await h.route("tg:123", "Help me plan my day", "tg:123", "dm");
  await h.drain("tg:123");
  assert.equal(h.config.workspaceByName("default")?.chat_id, "tg:123");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].cwd, h.config.homeWorkspacePath);
  assert.equal(h.calls[0].sessionId, null);
  assert.match(h.calls[0].prompt, /Help me plan my day/);
  t.diagnostic(JSON.stringify({ input: "first authorized DM", workspace: h.config.workspaceByName("default"), engineCalls: h.calls.length }));
});

test("bootstrap preserves existing home, project, instructions and runtime on restart", (t) => {
  const h = harness(t);
  h.config.ensureHomeWorkspace();
  const home = { ...h.config.workspaceByName("default")!, project: "custom-home", model: "chosen", current_session_id: "existing", chat_id: "tg:123" };
  h.config.upsertWorkspace(home);
  h.config.addProject({ name: "custom-home", main_workspace: "default", description: "custom" });
  fs.mkdirSync(h.config.instructionsDir, { recursive: true });
  fs.writeFileSync(path.join(h.config.instructionsDir, "IDENTITY.md"), "Keep my identity");
  const before = fs.readFileSync(path.join(h.root, "config.json"), "utf8");
  assert.deepEqual(h.config.ensureHomeWorkspace(), home);
  assert.equal(fs.readFileSync(path.join(h.root, "config.json"), "utf8"), before);
  assert.equal(fs.readFileSync(path.join(h.config.instructionsDir, "IDENTITY.md"), "utf8"), "Keep my identity");
});

test("pairing supplies the home destination; another approval cannot rebind it", (t) => {
  const h = harness(t);
  const code = h.config.createPairing("slack:U123", "Owner", "slack:D123");
  const pairing = h.config.consumePairing(code)!;
  h.config.approveUser(pairing.userId, pairing.userName);
  assert.equal(h.config.connectHomeWorkspace(pairing.chatId), true);
  h.config.approveUser("tg:999", "Another user");
  assert.equal(h.config.connectHomeWorkspace("tg:999"), false);
  assert.equal(h.config.workspaceByName("default")?.chat_id, "slack:D123");
});

test("home cannot bind an occupied DM", (t) => {
  const h = harness(t);
  h.config.upsertWorkspace({ name: "existing", cwd: h.root, chat_id: "tg:123", current_session_id: "existing" });
  assert.equal(h.config.connectHomeWorkspace("tg:123"), false);
  assert.equal(h.config.workspaceByChat("tg:123")?.name, "existing");
  assert.equal(h.config.workspaceByName("default")?.chat_id, null);
});

test("only a root DM reaches home; topics, groups and other users do not", async (t) => {
  const h = harness(t); await h.start();
  for (const [chatId, userId] of [["tg:123:70", "tg:123"], ["tg:-100", "tg:123"], ["tg:456", "tg:123"]]) {
    assert.equal(h.channel.isRootDM(chatId, userId), false);
    await h.route(chatId, "Hello", userId);
    assert.equal(h.config.workspaceByName("default")?.chat_id, null);
  }
  assert.equal(h.channel.isRootDM("tg:123", "tg:123"), true);
  await h.route("tg:123", "Hello", "tg:123", "dm");
  assert.equal(h.config.workspaceByName("default")?.chat_id, "tg:123");
});

test("one call creates an independent project and chat and runs its brief with a fresh session", async (t) => {
  const h = harness(t); await h.start(); h.config.connectHomeWorkspace("tg:123");
  h.config.setSession("default", "private-home-session");
  const result = await h.tool("workspace_create").handler({ name: "apog", cwd: h.root, description: "Apog development", brief: "Build Apog", own_project: true });
  const apog = h.config.workspaceByName("apog")!;
  assert.equal(apog.project, "apog");
  assert.equal(h.config.projectByName("apog")?.main_workspace, "apog");
  assert.equal(h.config.projectByName("home")?.main_workspace, "default");
  assert.deepEqual(h.created[0], { project: "apog", anchor: "tg:123", name: "apog" });
  assert.equal(apog.description, "Apog development");
  await h.drain(apog.chat_id!);
  assert.equal(h.calls[0].sessionId, null);
  assert.match(h.calls[0].prompt, /Build Apog/);
  assert.equal(h.config.workspaceByName("default")?.current_session_id, "private-home-session");
  assert.equal(h.config.workspaceByName("apog")?.pending_brief, undefined);
  t.diagnostic(JSON.stringify({ input: "workspace_create apog", response: result.content, project: h.config.projectByName("apog"), initialSession: h.calls[0].sessionId }));
});

test("manual workspace survives restart and connects without sharing home or allowing a rebind", async (t) => {
  const h = harness(t); await h.start(); h.config.connectHomeWorkspace("tg:123");
  h.press("manual");
  await h.tool("workspace_create").handler({ name: "manual", cwd: h.root, description: "Manual project", brief: "The saved brief", own_project: true });
  h.press("spawn");
  assert.equal(h.created.length, 0);
  assert.equal(h.config.workspaceByName("manual")?.chat_id, null);
  await h.restart();
  await h.route("tg:-100", "/connect manual", "tg:unauthorized");
  assert.equal(h.config.workspaceByName("manual")?.chat_id, null);
  await h.route("tg:-100", "Hello");
  assert.equal(h.calls.length, 0);
  await h.route("tg:-100", "/connect manual");
  await h.drain("tg:-100");
  assert.equal(h.config.workspaceByName("manual")?.chat_id, "tg:-100");
  assert.match(h.calls[0].prompt, /The saved brief/);
  assert.equal(h.calls[0].sessionId, null);
  await h.route("tg:-200", "/connect manual");
  assert.equal(h.config.workspaceByName("manual")?.chat_id, "tg:-100");
});

test("failed and cancelled first turns retain the brief for retry", async (t) => {
  const h = harness(t); await h.start(); h.config.connectHomeWorkspace("tg:123");
  await h.tool("workspace_create").handler({ name: "retry", cwd: h.root, description: "Retry", brief: "Do not lose this", own_project: true });
  const chatId = h.config.workspaceByName("retry")!.chat_id!;
  h.engine.runTurn = async function* (opts) {
    h.calls.push(opts); yield { type: "error", message: "Temporary failure" }; yield { type: "done", sessionId: "failed-session" };
  };
  await h.drain(chatId);
  assert.equal(h.config.workspaceByName("retry")?.pending_brief?.text, "Do not lose this");
  h.engine.runTurn = async function* (opts) {
    h.calls.push(opts); await h.route(chatId, "/cancel"); yield { type: "done", sessionId: "cancelled-session" };
  };
  await h.route(chatId, "Retry"); await h.drain(chatId);
  assert.equal(h.config.workspaceByName("retry")?.pending_brief?.text, "Do not lose this");
  h.engine.runTurn = async function* (opts) { h.calls.push(opts); yield { type: "done", sessionId: "success" }; };
  await h.route(chatId, "Try again"); await h.drain(chatId);
  assert.match(h.calls.at(-1)!.prompt, /Do not lose this/);
  assert.equal(h.config.workspaceByName("retry")?.pending_brief, undefined);
});

test("failed chat creation leaves no new workspace or project", async (t) => {
  const h = harness(t); await h.start(); h.config.connectHomeWorkspace("tg:123");
  const args = { name: "new", cwd: h.root, description: "New project", brief: "New work", own_project: true };
  h.channel.createProjectChat = async () => { throw new Error("Missing permission"); };
  const result = await h.tool("workspace_create").handler(args);
  assert.match(result.content[0].text, /Missing permission/);
  assert.equal(h.config.workspaceByName("new"), undefined);
  assert.equal(h.config.projectByName("new"), undefined);
  assert.equal(fs.existsSync(h.root), true);
});

test("a scheduled prompt still runs in home's normal session", async (t) => {
  const h = harness(t); await h.start(); h.config.connectHomeWorkspace("tg:123");
  h.config.setSession("default", "home-session");
  await h.tool("schedule_create").handler({ cron: new Date(Date.now() + 2000).toISOString(), prompt: "Scheduled check" });
  for (let attempt = 0; attempt < 200 && h.config.listSchedules().length; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await h.drain("tg:123");
  assert.equal(h.config.listSchedules().length, 0);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].prompt, /Scheduled check/);
  assert.equal(h.calls[0].sessionId, "home-session");
});

test("a message arriving during project setup receives the brief only once", async (t) => {
  const h = harness(t); await h.start(); h.config.connectHomeWorkspace("tg:123");
  h.channel.setupProject = async (_name, chatId) => { await h.route(chatId, "Start now"); };
  await h.tool("workspace_create").handler({ name: "early", cwd: h.root, description: "Early message", brief: "Unique first brief", own_project: true });
  await h.drain(h.config.workspaceByName("early")!.chat_id!);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].prompt.match(/Unique first brief/g)?.length, 1);
});

test("creation rollback does not close a chat connected elsewhere during the platform await", async (t) => {
  const h = harness(t); await h.start(); h.config.connectHomeWorkspace("tg:123");
  h.config.upsertWorkspace({ name: "other", cwd: h.root, chat_id: null, current_session_id: null });
  const closed: string[] = [];
  h.channel.closeProjectChat = async (id) => { closed.push(id); };
  h.channel.createProjectChat = async () => {
    await h.route("tg:123:90", "/connect other");
    return "tg:123:90";
  };
  const result = await h.tool("workspace_create").handler({ name: "raced", cwd: h.root, description: "Race", brief: "Raced work", own_project: true });
  assert.match(result.content[0].text, /already connected/);
  assert.equal(h.config.workspaceByChat("tg:123:90")?.name, "other");
  assert.equal(h.config.workspaceByName("raced"), undefined);
  assert.deepEqual(closed, []);
});

test("an unbound manual workspace can be archived without a platform closure", async (t) => {
  const h = harness(t); await h.start(); h.config.connectHomeWorkspace("tg:123");
  h.press("manual");
  await h.tool("workspace_create").handler({ name: "unused", cwd: h.root, description: "Unused", brief: "Never started", own_project: true });
  h.press("spawn");
  h.channel.sendInteractive = async () => ({ value: "yes" });
  h.channel.closeProjectChat = async () => { assert.fail("An unbound workspace has no chat to close"); };
  const result = await h.tool("workspace_archive").handler({ name: "unused" });
  assert.match(result.content[0].text, /archived/);
  assert.equal(h.config.workspaceByName("unused"), undefined);
  assert.equal(h.config.projectByName("unused"), undefined);
  assert.equal(fs.existsSync(h.root), true);
});

test("project adoption protects mains referenced by inconsistent legacy records", async (t) => {
  const h = harness(t); await h.start(); h.config.connectHomeWorkspace("tg:123");
  h.config.upsertWorkspace({ name: "peer", cwd: h.root, chat_id: null, current_session_id: null, project: "home" });
  h.config.addProject({ name: "legacy", description: "Legacy reference", main_workspace: "peer" });
  const result = await h.tool("project_create").handler({ name: "adopted", main_workspace: "peer", description: "Adoption" });
  assert.match(result.content[0].text, /already belongs to project "legacy" as its main/);
  assert.equal(h.config.projectByName("adopted"), undefined);
  const reassigned = await h.tool("project_update").handler({ name: "legacy", main_workspace: "default" });
  assert.match(reassigned.content[0].text, /already belongs to project "legacy"/);
  assert.equal(h.config.projectByName("legacy")?.main_workspace, "peer");
});
