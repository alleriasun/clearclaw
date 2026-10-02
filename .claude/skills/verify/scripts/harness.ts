// ClearClaw verification harness: the real Orchestrator and engines behind a recording
// Channel, on a scratch CLEARCLAW_HOME, driven over loopback HTTP. The channel is a fake
// "term:" one, or the real TelegramChannel on a test bot driven by a real Telegram user
// (telegram.ts). Run through ./ccv (see SKILL.md); `serve` is internal.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Button, ButtonResponse, Channel } from "../../../../src/types.js";
import { LOCK, assertBotFree, assertNotProduction, deleteTopics, dropPendingUpdates, ensureGroup, loadSecrets, readLock, releaseLock, telegramDriver, telegramSetup, type Secrets } from "./telegram.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ROOT = path.join("/tmp/clearclaw-verify", `${path.basename(REPO)}-${crypto.createHash("sha256").update(REPO).digest("hex").slice(0, 8)}`);
const HOME = path.join(ROOT, "home");
const WORK = path.join(ROOT, "work");
const STATE = path.join(ROOT, "state.json");
const OWNER = { id: "term:owner", name: "Verifier", handle: "verifier" };
const QUIET_MS = 3000;
const PROMPT_QUIET_MS = 1000;
const CHANNELS = ["term", "telegram"] as const;
type ChannelKind = (typeof CHANNELS)[number];

interface State { pid: number; port: number; head: string; code: string; evidence: string; mode: string; channel: ChannelKind }
export interface Entry { seq: number; t: number; dir: "in" | "out" | "tg"; op: string; chat?: string; [k: string]: unknown }

const readState = (): State | null => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : null);
// kill(0 or negative) signals a process group, so only a real pid counts.
const alive = (pid: number): boolean => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const git = (...args: string[]): string => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
/** sha256 over the code the daemon loads: paths and contents, so restores and deletions count too. */
function codeFingerprint(): string {
  const h = crypto.createHash("sha256");
  for (const dir of ["src", path.relative(REPO, path.dirname(fileURLToPath(import.meta.url)))]) {
    for (const f of (fs.readdirSync(path.join(REPO, dir), { recursive: true }) as string[]).sort()) {
      const abs = path.join(REPO, dir, f);
      if (fs.statSync(abs).isFile()) h.update(`${dir}/${f}\0`).update(fs.readFileSync(abs)).update("\0");
    }
  }
  return h.digest("hex");
}

// --- serve: the daemon process ---

export type Recorder = (e: Omit<Entry, "seq" | "t">) => void;
export interface PendingPrompt { id: string; chat: string; buttons: Button[][] }
/** One per channel kind: the Channel the Orchestrator talks to, and how a user acts on it. */
export interface Driver {
  channel: Channel;
  dmChat: string;
  send(chat: string, text: string): Promise<void>;
  press(p: PendingPrompt, button: Button, text?: string): Promise<void>;
  health?(): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

function termDriver(nextHandle: () => string, lastSeq: () => number): Driver {
  // Keyed by the prompt's buttons array, which the recorder passes through unchanged.
  const waiting = new Map<Button[][], (r: ButtonResponse) => void>();
  class TermChannel extends EventEmitter implements Channel {
    name = "term";
    async connect(): Promise<void> {}
    async disconnect(): Promise<void> {}
    ownsId(chatId: string): boolean { return chatId.startsWith("term:"); }
    isRootDM(chatId: string, userId: string): boolean { return chatId === "term:dm" && userId === OWNER.id; }
    async sendMessage(): Promise<string[]> { return [nextHandle()]; }
    sendInteractive(_chat: string, _text: string, buttons: Button[][]): Promise<ButtonResponse> {
      return new Promise((resolve) => waiting.set(buttons, resolve));
    }
    async editMessage(): Promise<void> {}
    async deleteMessage(): Promise<void> {}
    async pinMessage(): Promise<void> {}
    async unpinAllMessages(): Promise<void> {}
    async updateStatus(): Promise<void> {}
    async setTyping(): Promise<void> {}
    async sendFile(): Promise<void> {}
    async reactToMessage(): Promise<void> {}
    async createProjectChat(_projectName: string, _anchor: string, title: string): Promise<string> {
      return `term:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    }
    async closeProjectChat(): Promise<void> {}
    async groupProjectChat(): Promise<string | undefined> { return undefined; }
  }
  const channel = new TermChannel();
  return {
    channel,
    dmChat: "term:dm",
    async send(chat, text) {
      channel.emit("message", {
        chatId: chat, chatType: chat === "term:dm" ? "dm" : "group",
        origin: { kind: "user", user: OWNER }, text, messageId: `u${lastSeq()}`,
      });
    },
    async press(p, button, text) {
      const resolve = waiting.get(p.buttons)!;
      waiting.delete(p.buttons);
      resolve({ value: button.value, ...(text ? { text } : {}) });
    },
    async stop() {},
  };
}

/** Wrap the driver's channel so every outbound call is recorded, then delegated. */
function recording(driver: Driver, record: Recorder, nextHandle: () => string, evidence: string) {
  const inner = driver.channel;
  const typing = new Set<string>();
  const pending = new Map<string, PendingPrompt>();
  let files = 0;
  const out = async <T>(op: string, chat: string | undefined, fn: () => Promise<T>, fields: (r?: T) => object = () => ({})): Promise<T> => {
    try {
      const r = await fn();
      record({ dir: "out", op, chat, ...fields(r) });
      return r;
    } catch (err) {
      record({ dir: "out", op, chat, ...fields(), error: (err as Error).message });
      throw err;
    }
  };
  const over: Partial<Channel> = {
    connect: () => out("connect", undefined, () => inner.connect()),
    disconnect: () => out("disconnect", undefined, async () => { await inner.disconnect(); await driver.stop(); }),
    sendMessage: (chat, text, opts) => out("send", chat, () => inner.sendMessage(chat, text, opts), (h) => ({
      handle: h?.[0], ...(h && h.length > 1 ? { handles: h } : {}), text, ...(JSON.stringify(opts ?? {}) !== "{}" ? { opts } : {}),
    })),
    sendInteractive: async (chat, text, buttons) => {
      const id = nextHandle();
      record({ dir: "out", op: "interactive", chat, handle: id, text, buttons });
      pending.set(id, { id, chat, buttons });
      try {
        const r = await inner.sendInteractive(chat, text, buttons);
        record({ dir: "in", op: "answered", chat, handle: id, value: r.value, ...(r.text !== undefined ? { text: r.text } : {}) });
        return r;
      } catch (err) {
        record({ dir: "out", op: "interactive", chat, handle: id, error: (err as Error).message });
        throw err;
      } finally {
        pending.delete(id);
      }
    },
    editMessage: (chat, h, text, opts) => out("edit", chat, () => inner.editMessage(chat, h, text, opts), () => ({ handle: h, text })),
    deleteMessage: (chat, h) => out("delete", chat, () => inner.deleteMessage(chat, h), () => ({ handle: h })),
    pinMessage: (chat, h) => out("pin", chat, () => inner.pinMessage(chat, h), () => ({ handle: h })),
    unpinAllMessages: (chat) => out("unpinAll", chat, () => inner.unpinAllMessages(chat)),
    updateStatus: (chat, text) => out("status", chat, () => inner.updateStatus(chat, text), () => ({ text })),
    setTyping: async (chat, on) => {
      if (on !== typing.has(chat)) {
        on ? typing.add(chat) : typing.delete(chat);
        record({ dir: "out", op: "typing", chat, on });
      }
      await inner.setTyping(chat, on);
    },
    sendFile: (chat, buffer, filename, opts) => {
      const saved = path.join(evidence, "files", `${++files}-${path.basename(filename)}`);
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.writeFileSync(saved, buffer);
      return out("file", chat, () => inner.sendFile(chat, buffer, filename, opts), () => ({ filename, bytes: buffer.length, saved, ...(opts ? { opts } : {}) }));
    },
    reactToMessage: (chat, messageId, emoji) => out("react", chat, () => inner.reactToMessage(chat, messageId, emoji), () => ({ messageId, emoji })),
    createProjectChat: (projectName, anchor, title) =>
      out("createProjectChat", undefined, () => inner.createProjectChat!(projectName, anchor, title), (chat) => ({ chat, projectName, anchor, title })),
    closeProjectChat: (chat, projectName) => out("closeProjectChat", chat, () => inner.closeProjectChat!(chat, projectName), () => ({ projectName })),
    groupProjectChat: (projectName, chat) =>
      out("groupProjectChat", chat, () => inner.groupProjectChat!(projectName, chat), (note) => ({ projectName, ...(note ? { note } : {}) })),
  };
  // Optional methods the inner channel lacks stay absent: the Orchestrator feature-tests them with `?.`.
  const channel = new Proxy(inner, {
    get: (t, k) => {
      if (k in over && k in t) return over[k as keyof Channel];
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { channel, typing, pending };
}

async function serve(): Promise<void> {
  const state = readState()!;
  const { Config } = await import("../../../../src/config.js");
  const { initLogger } = await import("../../../../src/logger.js");
  const { createEngineMap } = await import("../../../../src/engine/registry.js");
  const { Orchestrator } = await import("../../../../src/orchestrator.js");

  const transcript = path.join(state.evidence, "transcript.jsonl");
  const entries: Entry[] = [];
  let lastOut = 0;
  const record: Recorder = (e) => {
    const entry = { seq: entries.length + 1, t: Date.now(), ...e } as Entry;
    entries.push(entry);
    if (entry.dir !== "in") lastOut = entry.t;
    fs.appendFileSync(transcript, JSON.stringify(entry) + "\n");
  };
  let handle = 0;
  const nextHandle = (): string => `m${++handle}`;

  // Mirrors runDaemon in src/index.ts: tolerate the known SDK abort bug, die on anything else.
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (/Operation aborted|Failed to write to process stdin|Cannot write to terminated process/.test(msg)) return;
    console.error("FATAL unhandled rejection:", reason);
    process.exit(1);
  });

  const config = new Config().resolve();
  initLogger(config.logPath);
  const driver = state.channel === "telegram"
    ? await telegramDriver(record, (userId) => config.isAuthorized(userId), REPO)
    : termDriver(nextHandle, () => entries.length);
  const { channel, typing, pending } = recording(driver, record, nextHandle, state.evidence);
  // `dm`, else a workspace's chat from config.json, so peers become addressable once created.
  const chatFor = (name: string): string => {
    if (name === "dm") return driver.dmChat;
    const known = config.listWorkspaces().filter((w) => w.chat_id);
    const hit = known.find((w) => w.name === name)?.chat_id;
    if (hit) return hit;
    if (state.channel === "term") return `term:${name}`;
    throw new Error(`no workspace "${name}" with a chat; known: dm, ${known.map((w) => w.name).join(", ")}`);
  };
  await new Orchestrator({ channel, engines: createEngineMap(config.engines), config }).start();

  const settle = async (since: number, timeoutMs: number): Promise<{ entries: Entry[]; pending: string[]; timedOut: boolean }> => {
    // Quiet counts from the action, not the last entry: a real channel delivers the action asynchronously.
    const start = Date.now();
    const deadline = start + timeoutMs;
    let timedOut = false;
    for (;;) {
      const quiet = Date.now() - Math.max(lastOut, start);
      const hasPending = [...pending.keys()].some((id) => entries.find((e) => e.handle === id)!.seq > since);
      // A short quiet after a prompt lets Telegram's echo of it (`tg` entries) land in the same output.
      if (hasPending && quiet >= PROMPT_QUIET_MS) break;
      if (typing.size === 0 && quiet >= QUIET_MS) break;
      if (Date.now() > deadline) { timedOut = true; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    return { entries: entries.slice(since), pending: [...pending.keys()], timedOut };
  };

  const server = http.createServer(async (req, res) => {
    const body = await new Promise<Record<string, unknown>>((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
    });
    const reply = (code: number, data: unknown): void => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    const timeout = Number(body.timeout ?? 300) * 1000;
    const url = req.url ?? "";
    try {
      if (url === "/health") {
        return reply(200, {
          pid: process.pid, home: process.env.CLEARCLAW_HOME, channel: state.channel, events: entries.length, typing: [...typing], pending: [...pending.keys()],
          ...(driver.health ? { driver: await driver.health() } : {}),
        });
      }
      if (url === "/log") return reply(200, { entries: entries.slice(Number(body.since ?? 0)) });
      if (url === "/send") {
        const chat = chatFor(String(body.chat ?? "dm"));
        const since = entries.length;
        record({ dir: "in", op: "message", chat, text: body.text });
        await driver.send(chat, String(body.text));
        return reply(200, await settle(since, timeout));
      }
      if (url === "/press") {
        const ids = [...pending.keys()];
        const id = (body.id as string | undefined) ?? (ids.length === 1 ? ids[0] : undefined);
        const p = id ? pending.get(id) : undefined;
        if (!p) return reply(400, { error: ids.length ? `pending prompts: ${ids.join(", ")} — pass --id` : "no pending prompt" });
        const want = String(body.value).toLowerCase();
        // Buttons can share a value (Deny vs Deny + Note); --text picks the one that asks for text.
        const matches = p.buttons.flat().filter((b) => b.value.toLowerCase() === want || b.label.toLowerCase() === want);
        const button = matches.find((b) => !!b.requestText === !!body.text) ?? matches[0];
        if (!button) return reply(400, { error: `no button "${body.value}"; have: ${p.buttons.flat().map((b) => `${b.label}=${b.value}`).join(", ")}` });
        // Telegram finds the prompt's message by labels, newest first, so an older twin would press the wrong one.
        const sig = (q: PendingPrompt): string => JSON.stringify(q.buttons.map((r) => r.map((b) => b.label)));
        if (state.channel === "telegram" && [...pending.values()].some((o) => o.chat === p.chat && Number(o.id.slice(1)) > Number(p.id.slice(1)) && sig(o) === sig(p))) {
          return reply(400, { error: `two pending prompts in ${p.chat} have identical buttons; answer the newer one first or cancel` });
        }
        const since = entries.length;
        record({ dir: "in", op: "press", chat: p.chat, handle: id, value: button.value, ...(body.text ? { text: body.text } : {}) });
        await driver.press(p, button, body.text ? String(body.text) : undefined);
        return reply(200, await settle(since, timeout));
      }
      if (url === "/wait") return reply(200, await settle(Number(body.since ?? entries.length), timeout));
      reply(404, { error: "unknown route" });
    } catch (err) {
      reply(500, { error: (err as Error).message });
    }
  });
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    fs.writeFileSync(STATE, JSON.stringify({ ...readState(), pid: process.pid, port }, null, 2));
  });
}

// --- client commands ---

function seedHome(tg?: Secrets, groupChat?: string): void {
  fs.mkdirSync(path.join(WORK, "proj"), { recursive: true });
  fs.writeFileSync(path.join(WORK, "proj", "README.md"), "# proj\n\nScratch project for ClearClaw verification.\n");
  const real = path.join(os.homedir(), ".clearclaw", "config.json");
  // Mirror the owner's engine setup (paths/settings files only, never the channel token).
  let engines = fs.existsSync(real) ? JSON.parse(fs.readFileSync(real, "utf8")).engines : undefined;
  if (!engines?.length) engines = [{ name: "claude-code", default: true, path: execFileSync("which", ["claude"], { encoding: "utf8" }).trim() }];
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, "config.json"), JSON.stringify({
    channel: { type: "telegram", botToken: tg?.botToken ?? "ccv-unused-never-connected" },
    engines,
    authorizedUsers: [{ id: tg ? `tg:${tg.userId}` : OWNER.id, name: OWNER.name, approvedAt: Date.now() }],
    workspaces: [{ name: "proj", cwd: path.join(WORK, "proj"), chat_id: groupChat ?? "term:proj", current_session_id: null }],
  }, null, 2), { mode: 0o600 });
}

async function call(route: string, body: object = {}): Promise<Record<string, unknown>> {
  const state = readState();
  if (!state || !alive(state.pid)) throw new Error("no running instance — run `ccv up`");
  const res = await fetch(`http://127.0.0.1:${state.port}${route}`, { method: "POST", body: JSON.stringify(body) });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error));
  return data;
}

function render(e: Entry): string {
  const { seq, dir, op, chat, t: _t, ...rest } = e;
  const text = typeof rest.text === "string" ? rest.text : undefined;
  delete rest.text;
  const extra = Object.keys(rest).length ? " " + JSON.stringify(rest) : "";
  return `#${seq} ${{ in: ">>", out: "<<", tg: "tg" }[dir]} ${op}${chat ? ` [${chat}]` : ""}${extra}${text !== undefined ? `\n${text.replace(/^/gm, "   ")}` : ""}`;
}

function printSettled(r: Record<string, unknown>): void {
  for (const e of r.entries as Entry[]) console.log(render(e));
  const pending = r.pending as string[];
  if (pending.length) console.log(`-- waiting on prompt ${pending.join(", ")}: answer with \`ccv press <value>\``);
  if (r.timedOut) console.log("-- TIMED OUT before the chat settled (turn still running?) — `ccv wait` to keep watching");
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const timeout = flag(args, "timeout");
  switch (cmd) {
    case "serve": return serve();
    case "up": {
      const prev = readState();
      if (prev && alive(prev.pid)) throw new Error(`already running (pid ${prev.pid}); \`ccv down\` first`);
      const mode = flag(args, "mode") ?? "default";
      const channel = (flag(args, "channel") ?? "term") as ChannelKind;
      if (!CHANNELS.includes(channel)) throw new Error(`--channel must be one of: ${CHANNELS.join(", ")}`);
      let tg: Secrets | undefined;
      let group: string | undefined;
      if (channel === "telegram") {
        tg = loadSecrets();
        assertNotProduction(tg.botToken);
        assertBotFree();
        group = await ensureGroup(tg);
        await dropPendingUpdates(tg.botToken); // so messages from earlier runs don't replay
      }
      fs.rmSync(HOME, { recursive: true, force: true });
      fs.rmSync(WORK, { recursive: true, force: true });
      seedHome(tg, group);
      const evidence = path.join(ROOT, "evidence", new Date().toISOString().replace(/[:.]/g, "-"));
      fs.mkdirSync(evidence, { recursive: true });
      const initial: State = { pid: 0, port: 0, head: git("rev-parse", "--short", "HEAD"), code: codeFingerprint(), evidence, mode, channel };
      fs.writeFileSync(STATE, JSON.stringify(initial, null, 2));
      const out = fs.openSync(path.join(evidence, "daemon.out"), "a");
      const env: NodeJS.ProcessEnv = { ...process.env, CLEARCLAW_HOME: HOME, PERMISSION_MODE: mode };
      for (const k of ["TELEGRAM_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "ALLOWED_USER_IDS", "ALLOWED_USER_ID"]) delete env[k];
      const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "serve"], { cwd: REPO, env, detached: true, stdio: ["ignore", out, out] });
      child.unref();
      if (child.pid) fs.writeFileSync(STATE, JSON.stringify({ ...initial, pid: child.pid }, null, 2));
      for (let i = 0; i < 150; i++) {
        const s = readState()!;
        if (s.port) {
          const chats = `${tg ? `dm   test user ${tg.userId} <-> @${tg.botUsername}\n` : ""}proj ${path.join(WORK, "proj")} (--chat proj${group ? `, forum group ${group}` : ""})`;
          console.log(`up: pid ${s.pid}, port ${s.port}, channel ${channel}, mode ${mode}, head ${s.head}\nhome ${HOME}\n${chats}\nevidence ${evidence}`);
          return;
        }
        if (!alive(child.pid!)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const pid = child.pid ?? 0;
      if (alive(pid)) {
        process.kill(pid, "SIGTERM");
        for (let i = 0; i < 15 && alive(pid); i++) await new Promise((r) => setTimeout(r, 200));
        if (alive(pid)) process.kill(pid, "SIGKILL");
      }
      if (channel === "telegram") releaseLock(pid);
      fs.rmSync(STATE, { force: true });
      throw new Error(`daemon failed to start — see ${path.join(evidence, "daemon.out")}`);
    }
    case "doctor": {
      const s = readState();
      if (!s) { console.log("DOWN: no instance for this checkout"); process.exitCode = 1; return; }
      const problems: string[] = [];
      if (!alive(s.pid)) problems.push(`pid ${s.pid} is not running (stale state — run \`ccv down\`)`);
      const h = alive(s.pid) ? await call("/health").catch((e: Error) => { problems.push(`control port: ${e.message}`); return null; }) : null;
      if (h && h.home !== HOME) problems.push(`instance home is ${h.home}, expected ${HOME}`);
      if (h && h.pid !== s.pid) problems.push(`port ${s.port} answered as pid ${h.pid}, not ours (${s.pid})`);
      const head = git("rev-parse", "--short", "HEAD");
      if (head !== s.head) problems.push(`HEAD moved ${s.head} → ${head} since up; restart to run current code`);
      if (codeFingerprint() !== s.code) problems.push("src/ or harness changed since up; restart to run current code");
      let lock: ReturnType<typeof readLock> | undefined;
      if (s.channel === "telegram") {
        lock = readLock();
        if (!(lock?.alive && lock.pid === s.pid)) problems.push(lock?.alive ? `test bot lock held by pid ${lock.pid} (${lock.checkout}), not us` : `test bot lock ${LOCK} is not held by a live process`);
        const tg = h?.driver as { connected?: boolean; authorized?: boolean; group?: string; groupProblems?: string[] } | undefined;
        if (h && !(tg?.connected && tg.authorized)) problems.push("the Telegram user client is not connected and authorized");
        if (tg?.groupProblems?.length) problems.push(`test group ${tg.group}: ${tg.groupProblems.join("; ")}`);
      }
      console.log(JSON.stringify({ ...s, health: h, ...(lock !== undefined ? { lock } : {}), problems }, null, 2));
      console.log(problems.length ? `NOT OK:\n- ${problems.join("\n- ")}` : "OK");
      if (problems.length) process.exitCode = 1;
      return;
    }
    case "send": {
      const chat = flag(args, "chat") ?? "dm";
      if (!args.length) throw new Error("usage: ccv send [--chat dm|<workspace>] <text>");
      return printSettled(await call("/send", { chat, text: args.join(" "), timeout }));
    }
    case "press": {
      const id = flag(args, "id");
      const text = flag(args, "text");
      if (!args[0]) throw new Error("usage: ccv press <value|label> [--text note] [--id handle]");
      return printSettled(await call("/press", { value: args[0], id, text, timeout }));
    }
    case "where": {
      const paths: Record<string, string | undefined> = { root: ROOT, home: HOME, work: WORK, proj: path.join(WORK, "proj"), evidence: readState()?.evidence };
      if (!args[0]) { for (const [k, v] of Object.entries(paths)) console.log(`${k}\t${v ?? "(no instance)"}`); return; }
      if (!(args[0] in paths)) throw new Error(`usage: ccv where [${Object.keys(paths).join("|")}]`);
      if (!paths[args[0]]) throw new Error("no instance — run `ccv up`");
      console.log(paths[args[0]]);
      return;
    }
    case "telegram-setup": await telegramSetup(); process.exit(0);
    case "wait": return printSettled(await call("/wait", { timeout }));
    case "log": {
      const r = await call("/log");
      for (const e of r.entries as Entry[]) console.log(args.includes("--json") ? JSON.stringify(e) : render(e));
      return;
    }
    case "down": {
      const s = readState();
      if (!s) { console.log("nothing to stop"); return; }
      if (alive(s.pid)) {
        process.kill(s.pid, "SIGTERM");
        for (let i = 0; i < 50 && alive(s.pid); i++) await new Promise((r) => setTimeout(r, 200));
        if (alive(s.pid)) process.kill(s.pid, "SIGKILL");
      }
      if (s.channel === "telegram") {
        releaseLock(s.pid); // serve's exit hook misses a SIGKILL
        // Topics this run created: from the recorder, and from Telegram in case the call's result was lost.
        const log = path.join(s.evidence, "transcript.jsonl");
        const entries = (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []).map((l) => JSON.parse(l) as Entry);
        const topics = new Set(entries.flatMap((e) =>
          (e.op === "createProjectChat" || (e.op === "action" && String(e.text).startsWith("topic created"))) && e.chat ? [e.chat] : []));
        const n = await deleteTopics(loadSecrets(), [...topics]).catch((err: Error) => { console.log(`could not delete this run's topics: ${err.message}`); return 0; });
        if (n) console.log(`deleted ${n} topic(s) from the test group`);
      }
      for (const f of fs.existsSync(HOME) ? fs.readdirSync(HOME) : []) {
        if (f.startsWith("clearclaw.") && f.endsWith(".log")) fs.copyFileSync(path.join(HOME, f), path.join(s.evidence, f));
      }
      fs.rmSync(HOME, { recursive: true, force: true });
      fs.rmSync(WORK, { recursive: true, force: true });
      fs.rmSync(STATE, { force: true });
      console.log(`down. evidence kept at ${s.evidence}`);
      return;
    }
    default:
      console.log("usage: ccv up [--channel term|telegram] [--mode default|acceptEdits|bypassPermissions|plan|dontAsk] | doctor | send [--chat dm|<workspace>] <text> | press <value> [--text t] | wait | log [--json] | where [root|home|work|proj|evidence] | down | telegram-setup\n  send/press/wait accept --timeout <seconds> (default 300)");
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err: Error) => { console.error(`ccv: ${err.message}`); process.exit(1); });
