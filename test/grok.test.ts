import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GROK_RELAY_AGENT_ID,
  GrokChannel,
  applyTranscriptEntries,
  parseGrokAgentId,
} from "../src/channel/grok.js";
import type { InboundMessage } from "../src/types.js";

const RELAY = DEFAULT_GROK_RELAY_AGENT_ID;
const BASE = "http://grok-host:1340";
const TOKEN = "test-gateway-token";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  authorization?: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hangingSse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start() { /* stays open until abort */ },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function mockFetch(opts?: {
  tail?: unknown;
  extra?: (url: URL, init: RequestInit | undefined, calls: FetchCall[]) => Response | undefined;
}): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    let body: unknown;
    if (rawBody) {
      try { body = JSON.parse(rawBody); } catch { body = rawBody; }
    }
    const headers = new Headers(init?.headers);
    calls.push({
      url: url.toString(),
      method: (init?.method ?? "GET").toUpperCase(),
      body,
      authorization: headers.get("authorization"),
    });
    const extra = opts?.extra?.(url, init, calls);
    if (extra) return extra;
    if (url.pathname === "/health") return jsonResponse({ ok: true });
    if (url.pathname === "/events") return hangingSse();
    if (url.pathname === "/api/getAgentTranscriptTail") {
      return jsonResponse(opts?.tail ?? { entries: [] });
    }
    if (url.pathname === "/api/sendPrompt") return jsonResponse({ accepted: true });
    if (url.pathname === "/api/reactToMessage") return jsonResponse(null);
    if (url.pathname === "/api/interruptAgentRun") return jsonResponse({ hadActiveRun: true });
    if (url.pathname === "/api/respondToWidget") return jsonResponse({ accepted: true });
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetchImpl, calls };
}

function channel(fetchImpl: typeof fetch, extras: { pollIntervalMs?: number } = {}): GrokChannel {
  return new GrokChannel({
    gatewayUrl: BASE,
    token: TOKEN,
    relayAgentId: RELAY,
    fetch: fetchImpl,
    pollIntervalMs: extras.pollIntervalMs ?? 60_000,
  });
}

test("ownsId accepts grok: prefix and rejects others", () => {
  const { fetch: fetchImpl } = mockFetch();
  const ch = channel(fetchImpl);
  assert.equal(ch.ownsId("grok:abc"), true);
  assert.equal(ch.ownsId(`grok:${RELAY}`), true);
  assert.equal(ch.ownsId("grok:default"), true);
  assert.equal(ch.ownsId("tg:123"), false);
  assert.equal(ch.ownsId("slack:C123"), false);
  assert.equal(ch.ownsId("grok"), false);
});

test("parseGrokAgentId maps grok:default to the relay seat", () => {
  assert.equal(parseGrokAgentId("grok:default", RELAY), RELAY);
  assert.equal(parseGrokAgentId(`grok:${RELAY}`, RELAY), RELAY);
  assert.equal(parseGrokAgentId("grok:other-agent", RELAY), "other-agent");
  assert.throws(() => parseGrokAgentId("tg:1", RELAY), /must start with/);
});

test("sendMessage POSTs /api/sendPrompt with agentId and prompt", async () => {
  const { fetch: fetchImpl, calls } = mockFetch();
  const ch = channel(fetchImpl);
  const handles = await ch.sendMessage(`grok:${RELAY}`, "hello from mini");

  const sent = calls.find((c) => c.url.endsWith("/api/sendPrompt"));
  assert.ok(sent);
  assert.equal(sent.method, "POST");
  assert.equal(sent.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(
    { agentId: (sent.body as { agentId: string }).agentId, prompt: (sent.body as { prompt: string }).prompt },
    { agentId: RELAY, prompt: "hello from mini" },
  );
  assert.equal(typeof (sent.body as { clientNonce: string }).clientNonce, "string");
  assert.equal(handles.length, 1);
});

test("sendMessage resolves grok:default to GROK_RELAY_AGENT_ID", async () => {
  const { fetch: fetchImpl, calls } = mockFetch();
  const ch = channel(fetchImpl);
  await ch.sendMessage("grok:default", "ping");
  const sent = calls.find((c) => c.url.endsWith("/api/sendPrompt"));
  assert.equal((sent?.body as { agentId: string }).agentId, RELAY);
});

test("connect health-checks, opens SSE, and snapshots the tail cursor", async () => {
  const { fetch: fetchImpl, calls } = mockFetch({
    tail: {
      entries: [
        { id: "e1", seq: 4, role: "assistant", text: "historic" },
        { id: "e2", seq: 5, role: "assistant", text: "also historic" },
      ],
    },
  });
  const ch = channel(fetchImpl);
  const inbound: InboundMessage[] = [];
  ch.on("message", (msg) => inbound.push(msg));

  await ch.connect();
  try {
    const paths = calls.map((c) => new URL(c.url).pathname);
    assert.ok(paths.includes("/health"));
    assert.ok(paths.includes("/events"));
    assert.ok(paths.includes("/api/getAgentTranscriptTail"));
    const health = calls.find((c) => new URL(c.url).pathname === "/health");
    assert.equal(health?.authorization, null);
    const events = calls.find((c) => new URL(c.url).pathname === "/events");
    assert.equal(events?.authorization, `Bearer ${TOKEN}`);
    const tail = calls.find((c) => new URL(c.url).pathname === "/api/getAgentTranscriptTail");
    assert.deepEqual(tail?.body, { id: RELAY, limit: 50 });
    assert.equal(ch.tailSeq(RELAY), 5);
    assert.equal(inbound.length, 0, "startup snapshot must not replay history");
  } finally {
    await ch.disconnect();
  }
});

test("new assistant tail entries emit InboundMessage and are deduped by id/seq", async () => {
  const { fetch: fetchImpl } = mockFetch();
  const ch = channel(fetchImpl);
  const inbound: InboundMessage[] = [];
  ch.on("message", (msg) => inbound.push(msg));

  ch.ingestTranscriptEntries(RELAY, [
    { id: "old", seq: 1, role: "assistant", text: "already seen" },
  ], false);
  assert.equal(ch.tailSeq(RELAY), 1);

  ch.ingestTranscriptEntries(RELAY, [
    { id: "old", seq: 1, role: "assistant", text: "already seen" },
    { id: "user-1", seq: 2, role: "user", text: "own prompt echo" },
    { id: "new", seq: 3, role: "assistant", text: "fresh reply" },
  ], true);

  assert.equal(inbound.length, 1);
  assert.equal(inbound[0]?.chatId, `grok:${RELAY}`);
  assert.equal(inbound[0]?.messageId, "new");
  assert.equal(inbound[0]?.text, "fresh reply");
  assert.equal(ch.tailSeq(RELAY), 3);

  ch.ingestTranscriptEntries(RELAY, [
    { id: "new", seq: 3, role: "assistant", text: "fresh reply" },
  ], true);
  assert.equal(inbound.length, 1);
});

test("applyTranscriptEntries skips user echoes and keeps seq cursor", () => {
  const first = applyTranscriptEntries(
    [{ id: "a", seq: 10, role: "assistant", text: "hi" }],
    { seq: 0, ids: new Set() },
    false,
  );
  assert.equal(first.messages.length, 0);
  assert.equal(first.cursor.seq, 10);

  const next = applyTranscriptEntries(
    [
      { id: "a", seq: 10, role: "assistant", text: "hi" },
      { id: "b", seq: 11, role: "user", text: "echo" },
      { id: "c", seq: 12, role: "assistant", text: "reply" },
    ],
    first.cursor,
    true,
  );
  assert.deepEqual(next.messages.map((m) => m.id), ["c"]);
  assert.equal(next.cursor.seq, 12);
});

test("reactToMessage POSTs /api/reactToMessage", async () => {
  const { fetch: fetchImpl, calls } = mockFetch();
  const ch = channel(fetchImpl);
  await ch.reactToMessage("grok:default", "entry-9", "👍");
  const sent = calls.find((c) => c.url.endsWith("/api/reactToMessage"));
  assert.deepEqual(sent?.body, { entryId: "entry-9", emoji: "👍", agentId: RELAY });
});

test("interrupt POSTs /api/interruptAgentRun", async () => {
  const { fetch: fetchImpl, calls } = mockFetch();
  const ch = channel(fetchImpl);
  await ch.interrupt(`grok:${RELAY}`);
  const sent = calls.find((c) => c.url.endsWith("/api/interruptAgentRun"));
  assert.deepEqual(sent?.body, { id: RELAY });
});

test("sendInteractive uses respondToWidget for a pending widget entry", async () => {
  const { fetch: fetchImpl, calls } = mockFetch();
  const ch = channel(fetchImpl);
  ch.ingestTranscriptEntries(RELAY, [
    { id: "w1", seq: 1, role: "assistant", kind: "widget", text: "pick one" },
  ], true);
  await ch.sendInteractive("grok:default", "allow", [[{ label: "Allow", value: "allow" }]]);
  const widget = calls.find((c) => c.url.endsWith("/api/respondToWidget"));
  assert.deepEqual(widget?.body, { entryId: "w1", value: "allow", agentId: RELAY });
  assert.equal(calls.some((c) => c.url.endsWith("/api/sendPrompt")), false);
});

test("sendInteractive falls back to sendPrompt when no widget is pending", async () => {
  const { fetch: fetchImpl, calls } = mockFetch();
  const ch = channel(fetchImpl);
  await ch.sendInteractive("grok:default", "Allow Bash?", [
    [{ label: "Allow", value: "allow" }, { label: "Deny", value: "deny" }],
  ]);
  const sent = calls.find((c) => c.url.endsWith("/api/sendPrompt"));
  assert.ok(sent);
  assert.match((sent.body as { prompt: string }).prompt, /Allow Bash\?/);
  assert.match((sent.body as { prompt: string }).prompt, /allow/);
});

test("no-op channel methods resolve without gateway calls", async () => {
  const { fetch: fetchImpl, calls } = mockFetch();
  const ch = channel(fetchImpl);
  await ch.setTyping("grok:default", true);
  await ch.updateStatus("grok:default", "busy");
  await ch.editMessage("grok:default", "h", "x");
  await ch.deleteMessage("grok:default", "h");
  await ch.pinMessage("grok:default", "h");
  await ch.unpinAllMessages("grok:default");
  await ch.sendFile("grok:default", Buffer.from("x"), "x.txt");
  assert.equal(calls.length, 0);
});
