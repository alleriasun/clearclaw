// Real-Telegram mode: the real TelegramChannel on a dedicated test bot, driven by a real
// Telegram user account through gramjs (MTProto). gramjs and src/ load lazily so the other
// ccv commands stay fast.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import type { Api } from "telegram";
import type { NewMessageEvent } from "telegram/events/index.js";
import type { EditedMessageEvent } from "telegram/events/EditedMessage.js";
import type { DeletedMessageEvent } from "telegram/events/DeletedMessage.js";
import type { InboundMessage } from "../../../../src/types.js";
import type { Driver, Recorder } from "./harness.js";

export const SECRETS = path.join(os.homedir(), ".config", "clearclaw-verify", "telegram.json");
export const LOCK = "/tmp/clearclaw-verify/telegram.lock";
const SETUP = "run `ccv telegram-setup`";

export interface Secrets { apiId: number; apiHash: string; session: string; botToken: string; botUsername: string; userId: number }
const FIELDS = { apiId: "number", apiHash: "string", session: "string", botToken: "string", botUsername: "string", userId: "number" } as const;

// kill(0 or negative) signals a process group, so only a real pid counts.
const alive = (pid: number): boolean => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function loadSecrets(): Secrets {
  let raw: string;
  try { raw = fs.readFileSync(SECRETS, "utf8"); } catch { throw new Error(`no Telegram test credentials at ${SECRETS}; ${SETUP}`); }
  if (fs.statSync(SECRETS).mode & 0o077) throw new Error(`${SECRETS} is readable by other users; chmod 600 it`);
  let s: Record<string, unknown>;
  // Never surface the parse error: it quotes the file, which holds tokens.
  try { s = JSON.parse(raw); } catch { throw new Error(`${SECRETS} is not valid JSON; ${SETUP}`); }
  const bad = Object.entries(FIELDS).filter(([k, t]) => typeof s?.[k] !== t || !s[k]).map(([k]) => k);
  if (bad.length) throw new Error(`${SECRETS} has missing or invalid ${bad.join(", ")}; ${SETUP}`);
  return s as unknown as Secrets;
}

export function assertNotProduction(botToken: string): void {
  let prod: unknown;
  try { prod = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".clearclaw", "config.json"), "utf8")).channel?.botToken; } catch { /* no production config */ }
  if (botToken === prod || botToken === process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error("that bot token is the production bot's; the harness needs a dedicated test bot");
  }
}

async function botApi<T>(token: string, method: string): Promise<T> {
  const r = await (await fetch(`https://api.telegram.org/bot${token}/${method}`)).json() as { ok: boolean; result: T; description?: string };
  if (!r.ok) throw new Error(`Telegram Bot API ${method.split("?")[0]} failed: ${r.description}`);
  return r.result;
}

export const dropPendingUpdates = (token: string): Promise<boolean> => botApi<boolean>(token, "deleteWebhook?drop_pending_updates=true");

// The test bot is one poller across all checkouts (a second getUpdates poller gets 409).
export function readLock(): { pid: number; checkout: string; alive: boolean } | null {
  try {
    const l = JSON.parse(fs.readFileSync(LOCK, "utf8")) as { pid: number; checkout: string };
    return { ...l, alive: alive(l.pid) };
  } catch { return null; }
}

/** Throws if a live process holds the test bot; returns a stale lock, if any. */
export function assertBotFree(): ReturnType<typeof readLock> {
  const held = readLock();
  if (held?.alive) throw new Error(`the test bot is in use by pid ${held.pid} (${held.checkout}); \`ccv down\` there first`);
  return held;
}

function takeLock(checkout: string): void {
  if (assertBotFree()) fs.rmSync(LOCK, { force: true });
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, checkout }), { flag: "wx" });
}

export function releaseLock(pid: number): void {
  if (readLock()?.pid === pid) fs.rmSync(LOCK, { force: true });
}

async function newClient(apiId: number, apiHash: string, session: string) {
  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");
  const { Logger, LogLevel } = await import("telegram/extensions/Logger.js");
  let sess: InstanceType<typeof StringSession>;
  try { sess = new StringSession(session); } catch { throw new Error(`the saved Telegram user session is corrupt; ${SETUP}`); }
  const client = new TelegramClient(sess, apiId, apiHash, { connectionRetries: 5, baseLogger: new Logger(LogLevel.ERROR) });
  client.setParseMode(undefined); // send text verbatim, the way it was typed
  return { client, sess };
}

// The test group: a forum supergroup the test user owns, with the test bot as admin. Its ids
// are not secret, but the access hash only works with this user's session.
export const GROUP_FILE = path.join(path.dirname(SECRETS), "telegram-group.json");
interface Group { channelId: string; accessHash: string }
const RIGHTS = { changeInfo: true, deleteMessages: true, pinMessages: true, manageTopics: true, inviteUsers: true } as const;
const readGroup = (): Group | null => { try { return JSON.parse(fs.readFileSync(GROUP_FILE, "utf8")); } catch { return null; } };
/** Bot API form, as TelegramChannel sees it: tg:-100<channel id>. */
const groupChat = (g: Group): string => `tg:-100${g.channelId}`;
type Client = Awaited<ReturnType<typeof newClient>>["client"];

async function groupPeer(g: Group) {
  const { Api } = await import("telegram");
  const { returnBigInt } = await import("telegram/Helpers.js");
  return new Api.InputPeerChannel({ channelId: returnBigInt(g.channelId), accessHash: returnBigInt(g.accessHash) });
}

/** ["gone"] when the group can't be used at all; otherwise what needs repair. */
async function groupProblems(client: Client, s: Secrets, g: Group): Promise<string[]> {
  const { Api } = await import("telegram");
  const peer = await groupPeer(g);
  const ch = await client.invoke(new Api.channels.GetChannels({ id: [peer] })).then((r) => r.chats[0], () => undefined);
  if (!(ch instanceof Api.Channel) || ch.left || !ch.creator) return ["gone"];
  const p = await client.invoke(new Api.channels.GetParticipant({ channel: peer, participant: s.botUsername })).then((r) => r.participant, () => undefined);
  const rights = p instanceof Api.ChannelParticipantAdmin ? p.adminRights : undefined;
  const missing = Object.keys(RIGHTS).filter((k) => !rights?.[k as keyof typeof RIGHTS]);
  return [...(ch.forum ? [] : ["not a forum"]), ...(missing.length ? [`bot lacks admin rights: ${missing.join(", ")}`] : [])];
}

async function withClient<T>(s: Secrets, fn: (client: Client) => Promise<T>): Promise<T> {
  const { client } = await newClient(s.apiId, s.apiHash, s.session);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await Promise.race([client.destroy(), sleep(3000)]);
  }
}

/** Create, repair, or confirm the test group. Returns its chat id. */
export async function ensureGroup(s: Secrets): Promise<string> {
  const { Api } = await import("telegram");
  return withClient(s, async (client) => {
    let g = readGroup();
    let problems = g ? await groupProblems(client, s, g) : ["gone"];
    if (problems[0] === "gone") {
      const u = await client.invoke(new Api.channels.CreateChannel({
        title: "ClearClaw verify", about: "Test group for ClearClaw's ccv harness. Topics come and go.", megagroup: true, forum: true,
      }));
      const ch = (u as Api.Updates).chats.find((c): c is Api.Channel => c instanceof Api.Channel)!;
      g = { channelId: ch.id.toString(), accessHash: ch.accessHash!.toString() };
      fs.writeFileSync(GROUP_FILE, JSON.stringify(g, null, 2) + "\n", { mode: 0o600 });
      problems = await groupProblems(client, s, g);
    }
    const channel = await groupPeer(g!);
    if (problems.includes("not a forum")) await client.invoke(new Api.channels.ToggleForum({ channel, enabled: true }));
    // Promoting a bot that isn't a member adds it. Admin also lifts privacy mode for the bot.
    if (problems.some((p) => p.startsWith("bot lacks"))) {
      await client.invoke(new Api.channels.EditAdmin({ channel, userId: s.botUsername, adminRights: new Api.ChatAdminRights(RIGHTS), rank: "" }));
    }
    problems = await groupProblems(client, s, g!);
    if (problems.length) throw new Error(`test group ${groupChat(g!)} still broken after repair: ${problems.join("; ")}`);
    return groupChat(g!);
  });
}

/** Delete the given topics of the test group (the user is its creator). Returns how many. */
export async function deleteTopics(s: Secrets, chats: string[]): Promise<number> {
  const g = readGroup();
  const threads = g ? chats.filter((c) => c.startsWith(`${groupChat(g)}:`)).map((c) => Number(c.split(":")[2])) : [];
  if (!threads.length) return 0;
  const { Api } = await import("telegram");
  const channel = await groupPeer(g!);
  return withClient(s, async (client) => {
    for (const topMsgId of threads) {
      while ((await client.invoke(new Api.channels.DeleteTopicHistory({ channel, topMsgId }))).offset > 0);
    }
    return threads.length;
  });
}

export async function telegramDriver(record: Recorder, isAuthorized: (userId: string) => boolean, checkout: string): Promise<Driver> {
  const s = loadSecrets();
  takeLock(checkout);
  process.on("exit", () => releaseLock(process.pid));
  const { Api } = await import("telegram");
  const { NewMessage } = await import("telegram/events/index.js");
  const { EditedMessage } = await import("telegram/events/EditedMessage.js");
  const { DeletedMessage } = await import("telegram/events/DeletedMessage.js");
  const { Raw } = await import("telegram/events/Raw.js");
  const { TelegramChannel } = await import("../../../../src/channel/telegram.js");

  const { client } = await newClient(s.apiId, s.apiHash, s.session);
  await client.connect();
  if (!(await client.checkAuthorization())) throw new Error(`the saved Telegram user session is not authorized; ${SETUP}`);
  const bot = await client.getInputEntity(s.botUsername);
  const g = readGroup();
  if (!g) throw new Error(`no test group in ${GROUP_FILE}; \`ccv up --channel telegram\` creates it`);
  const group = await groupPeer(g);
  const root = groupChat(g);

  const dm = `tg:${s.userId}`;
  const botId = s.botToken.split(":")[0];
  type Msg = Api.Message | Api.MessageService;
  const inGroup = (m: Msg): boolean => m.peerId instanceof Api.PeerChannel && m.peerId.channelId.toString() === g.channelId;
  const fromBot = (m: Msg): boolean => !m.out && (inGroup(m)
    ? m.fromId instanceof Api.PeerUser && m.fromId.userId.toString() === botId
    : m.peerId instanceof Api.PeerUser && m.peerId.userId.toString() === botId);
  /** The chat id TelegramChannel uses for this message: the DM, the group root, or `root:<thread>` for a topic. */
  const chatOf = (m: Msg): string => {
    if (!inGroup(m)) return dm;
    const r = m.replyTo;
    const thread = r instanceof Api.MessageReplyHeader && r.forumTopic ? (r.replyToTopId ?? r.replyToMsgId)
      : m instanceof Api.MessageService && m.action instanceof Api.MessageActionTopicCreate ? m.id : undefined;
    return thread ? `${root}:${thread}` : root;
  };
  const target = (chat: string) => {
    if (chat === dm) return { peer: bot, thread: undefined };
    const thread = chat.startsWith(root) ? /^(?::(\d+))?$/.exec(chat.slice(root.length)) : null;
    if (!thread) throw new Error(`telegram mode can only reach ${dm} and ${root}[:<thread>], not ${chat}`);
    return { peer: group, thread: thread[1] ? Number(thread[1]) : undefined };
  };
  const labels = (m: Api.Message): string[][] | undefined =>
    m.replyMarkup instanceof Api.ReplyInlineMarkup ? m.replyMarkup.rows.map((r) => r.buttons.map((b) => b.text)) : undefined;
  const describe = (m: Api.Message) => {
    const entities = m.entities?.map((e) => `${e.className.replace(/^MessageEntity/, "").toLowerCase()}@${e.offset}+${e.length}`);
    const buttons = labels(m);
    return { chat: chatOf(m), msgId: m.id, ...(entities?.length ? { entities } : {}), ...(buttons ? { buttons } : {}), text: m.message };
  };
  // Message ids are per-chat for the group and per-account for the DM, so key by both.
  const key = (inGroupChat: boolean, id: number): string => `${inGroupChat ? "g" : "d"}${id}`;
  const seen = new Map<string, string>();
  client.addEventHandler((e: NewMessageEvent) => {
    if (!fromBot(e.message)) return;
    seen.set(key(inGroup(e.message), e.message.id), chatOf(e.message));
    record({ dir: "tg", op: "msg", ...describe(e.message) });
  }, new NewMessage({}));
  client.addEventHandler((e: EditedMessageEvent) => {
    if (fromBot(e.message)) record({ dir: "tg", op: "edit", ...describe(e.message) });
  }, new EditedMessage({}));
  // Private-chat deletions carry no peer, so match against ids seen from the bot in the DM.
  client.addEventHandler((e: DeletedMessageEvent) => {
    const ch = e.peer instanceof Api.PeerChannel;
    if (e.peer instanceof Api.PeerChannel && e.peer.channelId.toString() !== g.channelId) return;
    for (const msgId of e.deletedIds) {
      const chat = seen.get(key(ch, msgId));
      if (chat) record({ dir: "tg", op: "delete", chat, msgId });
    }
  }, new DeletedMessage({}));
  client.addEventHandler((u: Api.TypeUpdate) => {
    if (u instanceof Api.UpdatePinnedMessages && u.peer instanceof Api.PeerUser && u.peer.userId.toString() === botId) {
      record({ dir: "tg", op: "pin", chat: dm, msgIds: u.messages, pinned: !!u.pinned });
    } else if (u instanceof Api.UpdatePinnedChannelMessages && u.channelId.toString() === g.channelId) {
      record({ dir: "tg", op: "pin", chat: seen.get(key(true, u.messages[0])) ?? root, msgIds: u.messages, pinned: !!u.pinned });
    } else if (u instanceof Api.UpdateNewChannelMessage && u.message instanceof Api.MessageService && fromBot(u.message)) {
      const a = u.message.action;
      if (a instanceof Api.MessageActionPinMessage) return; // the pin op covers it
      const text = a instanceof Api.MessageActionTopicCreate ? `topic created: ${a.title}`
        : a instanceof Api.MessageActionTopicEdit ? (a.closed !== undefined ? `topic ${a.closed ? "closed" : "reopened"}` : `topic edited${a.title ? `: ${a.title}` : ""}`)
        : a.className;
      record({ dir: "tg", op: "action", chat: chatOf(u.message), msgId: u.message.id, text });
    }
  }, new Raw({ types: [Api.UpdatePinnedMessages, Api.UpdatePinnedChannelMessages, Api.UpdateNewChannelMessage] }));

  const until = async <T>(what: string, find: () => Promise<T | undefined>): Promise<T> => {
    for (let i = 0; i < 30; i++) {
      const found = await find();
      if (found) return found;
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const latestFromBot = (chat: string, match: (m: Api.Message) => boolean) => async () =>
    (await client.getMessages(target(chat).peer, { limit: 30 })).find((m) => fromBot(m) && chatOf(m) === chat && match(m));

  const channel = new TelegramChannel(s.botToken, isAuthorized, (chatId, user) => record({ dir: "in", op: "unauthorized", chat: chatId, user }));
  return {
    channel,
    dmChat: dm,
    async send(to, text) {
      const { peer, thread } = target(to);
      // Return once the bot has handed it to the Orchestrator, so settling starts from delivery.
      const delivered = new Promise<void>((resolve, reject) => {
        const on = (m: InboundMessage): void => {
          if (m.chatId !== to || m.text !== text.trim()) return;
          clearTimeout(timer);
          channel.off("message", on);
          resolve();
        };
        const timer = setTimeout(() => { channel.off("message", on); reject(new Error(`the bot did not receive the message as ${to} within 15s; see daemon.out`)); }, 15_000);
        channel.on("message", on);
      });
      // A client posts into a topic as a reply to the topic's root message, whose id is the thread id.
      await Promise.all([delivered, client.sendMessage(peer, { message: text, ...(thread ? { replyTo: thread } : {}) })]);
    },
    async press(p, button, text) {
      const want = JSON.stringify(p.buttons.map((r) => r.map((b) => b.label)));
      // Pressed keyboards get a ✅ label, so this finds the newest prompt still waiting.
      const msg = await until(`the bot message carrying prompt ${p.id}`, latestFromBot(p.chat, (m) => JSON.stringify(labels(m)) === want));
      const btn = (msg.replyMarkup as Api.ReplyInlineMarkup).rows.flatMap((r) => r.buttons)[p.buttons.flat().indexOf(button)];
      if (!(btn instanceof Api.KeyboardButtonCallback)) throw new Error(`button "${button.label}" is not a callback button`);
      await msg.click({ data: btn.data });
      if (text === undefined) return;
      const ask = await until("the bot's \"Add your feedback:\" prompt", latestFromBot(p.chat, (m) => m.id > msg.id && m.message === "Add your feedback:"));
      // Answer the force-reply the way a phone does: a reply to it, inside the same topic.
      const { peer, thread } = target(p.chat);
      await client.sendMessage(peer, { message: text, replyTo: ask.id, ...(thread ? { topMsgId: thread } : {}) });
    },
    async health() {
      return {
        connected: !!client.connected, authorized: await client.checkAuthorization().catch(() => false),
        group: root, groupProblems: await groupProblems(client, s, g).catch((e: Error) => [e.message]),
      };
    },
    async stop() {
      releaseLock(process.pid);
      await Promise.race([client.destroy(), sleep(3000)]);
    },
  };
}

export async function telegramSetup(): Promise<void> {
  let muted = false;
  const output = new Writable({ write: (chunk, _enc, cb) => { if (!muted) process.stdout.write(chunk); cb(); } });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
  let closed = false;
  rl.once("close", () => (closed = true));
  const lines = rl[Symbol.asyncIterator](); // buffers lines, so piped answers aren't dropped between prompts
  const ask = async (q: string, hidden = false): Promise<string> => {
    rl.setPrompt(q);
    rl.prompt();
    muted = hidden;
    try {
      const { value, done } = await lines.next();
      if (done) throw new Error("input ended before setup finished");
      return String(value).trim();
    } finally {
      if (muted) process.stdout.write("\n");
      muted = false;
    }
  };
  try {
    console.log([
      `Saves the Telegram test credentials \`ccv up --channel telegram\` uses to ${SECRETS}.`,
      "Have ready: api_id and api_hash from https://my.telegram.org (logged in as the test user),",
      "the test user's phone, and a token for a dedicated test bot from @BotFather (never the production bot).",
      "Secret answers are not echoed.",
    ].join("\n"));
    const apiId = Number(await ask("api_id: "));
    if (!Number.isInteger(apiId) || apiId <= 0) throw new Error("api_id must be a positive integer");
    const apiHash = await ask("api_hash: ", true);
    if (!apiHash) throw new Error("api_hash is required");
    const botToken = await ask("test bot token: ", true);
    if (!botToken) throw new Error("the test bot token is required");
    assertNotProduction(botToken);
    const botInfo = await botApi<{ username: string }>(botToken, "getMe");
    const { client, sess } = await newClient(apiId, apiHash, "");
    await client.start({
      phoneNumber: () => ask("test user's phone number (international format): "),
      phoneCode: () => ask("login code Telegram sent: ", true),
      password: () => ask("2FA password: ", true),
      onError: async (err) => { console.error(`login error: ${err.message}`); return closed; },
    });
    const me = await client.getMe();
    const secrets: Secrets = { apiId, apiHash, session: sess.save(), botToken, botUsername: botInfo.username, userId: me.id.toJSNumber() };
    fs.mkdirSync(path.dirname(SECRETS), { recursive: true, mode: 0o700 });
    fs.writeFileSync(SECRETS, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(SECRETS, 0o600);
    console.log(`saved ${SECRETS}: test bot @${secrets.botUsername}, test user id ${secrets.userId}`);
  } finally {
    rl.close();
  }
}
