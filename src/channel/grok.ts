import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import log from "../logger.js";
import type {
  Button,
  ButtonResponse,
  Channel,
  InboundMessage,
  MessageOpts,
  SendFileOpts,
} from "../types.js";

/** Default ClearClaw seat on the Grok Bot host. Override with GROK_RELAY_AGENT_ID. */
export const DEFAULT_GROK_RELAY_AGENT_ID = "53f49e93-8c14-4c1c-8748-0df28ccbaf69";

export const GROK_CHAT_PREFIX = "grok:";
export const GROK_DEFAULT_ALIAS = "default";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TAIL_LIMIT = 50;
const SSE_RETRY_MS = 5_000;
const RECENT_PROMPT_LIMIT = 32;

export interface GrokChannelOptions {
  gatewayUrl: string;
  token: string;
  relayAgentId?: string;
  /** Extra agent UUIDs to tail besides the relay seat. */
  agentIds?: string[];
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  tailLimit?: number;
}

export interface GrokTailCursor {
  seq: number;
  ids: Set<string>;
}

export interface GrokAssistantEntry {
  id: string;
  seq: number;
  text: string;
  role: string;
  kind: string;
}

/**
 * Parse `grok:<uuid>` or `grok:default` into a host agent id.
 * `grok:default` resolves to the relay seat.
 */
export function parseGrokAgentId(chatId: string, relayAgentId: string): string {
  if (!chatId.startsWith(GROK_CHAT_PREFIX)) {
    throw new Error(`Grok chat ID must start with "${GROK_CHAT_PREFIX}"`);
  }
  const rest = chatId.slice(GROK_CHAT_PREFIX.length).trim();
  if (!rest) {
    throw new Error("Grok chat ID is missing an agent id");
  }
  if (rest === GROK_DEFAULT_ALIAS) return relayAgentId;
  return rest;
}

export function grokChatId(agentId: string): string {
  return `${GROK_CHAT_PREFIX}${agentId}`;
}

export function normalizeGatewayUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Pull transcript rows out of host array-or-{entries} payloads. */
export function unwrapTranscriptEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && "entries" in payload) {
    const entries = (payload as { entries: unknown }).entries;
    if (Array.isArray(entries)) return entries;
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function nestedRecord(rec: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return asRecord(rec[key]);
}

export function transcriptEntryId(raw: unknown): string | undefined {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  for (const key of ["id", "entryId"] as const) {
    if (typeof rec[key] === "string" && rec[key]) return rec[key];
  }
  const inner = nestedRecord(rec, "entry") ?? nestedRecord(rec, "message");
  if (inner && typeof inner.id === "string" && inner.id) return inner.id;
  return undefined;
}

export function transcriptEntrySeq(raw: unknown): number {
  const rec = asRecord(raw);
  if (!rec) return 0;
  for (const key of ["seq", "sequence"] as const) {
    if (typeof rec[key] === "number" && Number.isFinite(rec[key])) return rec[key];
  }
  const inner = nestedRecord(rec, "entry");
  if (inner && typeof inner.seq === "number" && Number.isFinite(inner.seq)) return inner.seq;
  return 0;
}

function transcriptEntryKind(raw: unknown): string {
  const rec = asRecord(raw);
  if (!rec) return "";
  if (typeof rec.kind === "string") return rec.kind;
  const inner = nestedRecord(rec, "entry");
  if (inner && typeof inner.kind === "string") return inner.kind;
  return "";
}

function transcriptEntryRole(raw: unknown): string {
  const rec = asRecord(raw);
  if (!rec) return "";
  if (typeof rec.role === "string") return rec.role;
  const inner = nestedRecord(rec, "entry") ?? nestedRecord(rec, "message");
  if (inner && typeof inner.role === "string") return inner.role;
  const kind = transcriptEntryKind(raw).toLowerCase();
  if (kind === "assistant-text" || kind === "assistant") return "assistant";
  if (kind === "user" || kind === "send-message" || kind === "user-attachment") return "user";
  return "";
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (rec.type === "text" && typeof rec.text === "string") parts.push(rec.text);
    else if (typeof rec.text === "string") parts.push(rec.text);
  }
  return parts.join("\n");
}

export function transcriptEntryText(raw: unknown): string {
  const rec = asRecord(raw);
  if (!rec) return "";
  if (typeof rec.text === "string") return rec.text;
  if (typeof rec.content === "string" || Array.isArray(rec.content)) {
    const fromContent = textFromContent(rec.content);
    if (fromContent) return fromContent;
  }
  const message = nestedRecord(rec, "message");
  if (message) {
    if (typeof message.text === "string") return message.text;
    const fromContent = textFromContent(message.content);
    if (fromContent) return fromContent;
  }
  const inner = nestedRecord(rec, "entry");
  if (inner) {
    if (typeof inner.text === "string") return inner.text;
    const fromContent = textFromContent(inner.content);
    if (fromContent) return fromContent;
    const nestedMessage = nestedRecord(inner, "message");
    if (nestedMessage) {
      if (typeof nestedMessage.text === "string") return nestedMessage.text;
      const nestedText = textFromContent(nestedMessage.content);
      if (nestedText) return nestedText;
    }
  }
  return "";
}

function isWidgetEntry(raw: unknown): boolean {
  const kind = transcriptEntryKind(raw).toLowerCase();
  if (kind.includes("widget")) return true;
  const rec = asRecord(raw);
  if (!rec) return false;
  if (rec.widget != null || rec.awaitingUserResponse != null) return true;
  const inner = nestedRecord(rec, "entry");
  return Boolean(inner && (inner.widget != null || inner.awaitingUserResponse != null));
}

/**
 * Advance a tail cursor over opaque host transcript rows.
 * Emits only assistant text that is newer than the cursor (by seq, then id).
 * `emit=false` records the cursor without producing messages (startup snapshot).
 */
export function applyTranscriptEntries(
  entries: unknown[],
  cursor: GrokTailCursor,
  emit: boolean,
): { cursor: GrokTailCursor; messages: GrokAssistantEntry[]; widgetIds: string[] } {
  const ids = new Set(cursor.ids);
  let seq = cursor.seq;
  const messages: GrokAssistantEntry[] = [];
  const widgetIds: string[] = [];

  for (const raw of entries) {
    const entrySeq = transcriptEntrySeq(raw);
    const id = transcriptEntryId(raw) ?? (entrySeq > 0 ? `seq:${entrySeq}` : undefined);
    if (!id) continue;
    if (ids.has(id)) continue;
    if (entrySeq > 0 && entrySeq < cursor.seq) continue;

    ids.add(id);
    if (entrySeq > seq) seq = entrySeq;
    if (isWidgetEntry(raw)) widgetIds.push(id);

    if (!emit) continue;

    const role = transcriptEntryRole(raw) || "unknown";
    if (role !== "assistant") continue;
    const text = transcriptEntryText(raw).trim();
    if (!text) continue;
    messages.push({
      id,
      seq: entrySeq,
      text,
      role,
      kind: transcriptEntryKind(raw),
    });
  }

  return { cursor: { seq, ids }, messages, widgetIds };
}

/** Parse one SSE event block. Keepalives (`:ping`) and non-JSON data are ignored. */
export function parseSseBlock(block: string): { channel: string; payload: unknown } | null {
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed != null && typeof parsed === "object" && "channel" in parsed) {
      const rec = parsed as { channel: unknown; payload?: unknown };
      if (typeof rec.channel === "string") {
        return { channel: rec.channel, payload: rec.payload };
      }
    }
    return { channel: "unknown", payload: parsed };
  } catch {
    return null;
  }
}

class GrokGatewayError extends Error {
  constructor(
    readonly status: number,
    readonly command: string,
    message: string,
  ) {
    super(message);
    this.name = "GrokGatewayError";
  }
}

/** Thin fetch wrapper around GET /health, GET /events, POST /api/<command>. */
export class GrokGateway {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = normalizeGatewayUrl(baseUrl);
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  private authHeaders(extra?: Record<string, string>): Headers {
    const headers = new Headers(extra);
    headers.set("authorization", `Bearer ${this.token}`);
    return headers;
  }

  async health(): Promise<{ ok: boolean }> {
    const res = await this.fetchImpl(`${this.baseUrl}/health`);
    if (!res.ok) {
      throw new GrokGatewayError(res.status, "health", `Grok gateway health failed: ${res.status}`);
    }
    const body = (await res.json()) as { ok?: unknown };
    if (body.ok !== true) {
      throw new GrokGatewayError(res.status, "health", "Grok gateway health did not return {ok:true}");
    }
    return { ok: true };
  }

  async command<T = unknown>(name: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers = this.authHeaders();
    const init: RequestInit = { method: "POST", headers, signal };
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(`${this.baseUrl}/api/${name}`, init);
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const text = await res.text();
        if (text) {
          const parsed = JSON.parse(text) as { error?: unknown };
          if (typeof parsed.error === "string") detail = parsed.error;
        }
      } catch {
        // keep status text; never append raw bodies that might echo secrets
      }
      throw new GrokGatewayError(res.status, name, `Grok gateway ${name} failed: ${detail}`);
    }
    const text = await res.text();
    if (!text) return null as T;
    return JSON.parse(text) as T;
  }

  openEvents(signal: AbortSignal): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/events`, {
      method: "GET",
      headers: this.authHeaders({ accept: "text/event-stream" }),
      signal,
    });
  }
}

/**
 * Channel adapter for the Grok Bot host HTTP gateway (undocumented; accepted).
 * One channel per ClearClaw instance — selected when Slack/Telegram tokens are unset
 * and GROKBOT_GATEWAY_URL (or SAND_GATEWAY_URL) + SAND_GATEWAY_TOKEN are set.
 */
export class GrokChannel extends EventEmitter implements Channel {
  name = "grok";

  private readonly gateway: GrokGateway;
  private readonly relayAgentId: string;
  private readonly boundAgentIds: string[];
  private readonly pollIntervalMs: number;
  private readonly tailLimit: number;

  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sseAbort: AbortController | null = null;
  private pollAbort: AbortController | null = null;
  private sseLoop: Promise<void> | null = null;

  private readonly cursors = new Map<string, GrokTailCursor>();
  private readonly pendingWidgets = new Map<string, string>();
  private readonly recentPrompts: string[] = [];

  constructor(opts: GrokChannelOptions) {
    super();
    this.gateway = new GrokGateway(opts.gatewayUrl, opts.token, opts.fetch ?? fetch);
    this.relayAgentId = opts.relayAgentId ?? DEFAULT_GROK_RELAY_AGENT_ID;
    const extras = opts.agentIds ?? [];
    this.boundAgentIds = [...new Set([this.relayAgentId, ...extras])];
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.tailLimit = opts.tailLimit ?? DEFAULT_TAIL_LIMIT;
  }

  ownsId(chatId: string): boolean {
    return chatId.startsWith(GROK_CHAT_PREFIX);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.gateway.health();
    this.connected = true;
    this.pollAbort = new AbortController();
    this.sseAbort = new AbortController();
    await this.snapshotTails();
    this.startPoller();
    this.sseLoop = this.runSseLoop();
    log.info("[channel] Grok gateway connected (%s)", this.gateway.baseUrl);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.sseAbort?.abort();
    this.sseAbort = null;
    if (this.sseLoop) await this.sseLoop.catch(() => {});
    this.sseLoop = null;
  }

  async sendMessage(chatId: string, text: string, opts?: MessageOpts): Promise<string[]> {
    const agentId = parseGrokAgentId(chatId, this.relayAgentId);
    const clientNonce = randomUUID();
    this.rememberPrompt(text);
    const body: Record<string, unknown> = {
      agentId,
      prompt: text,
      clientNonce,
    };
    if (opts?.replyToMessageId) body.replyToId = opts.replyToMessageId;
    await this.gateway.command("sendPrompt", body, this.pollAbort?.signal);
    return [clientNonce];
  }

  async sendInteractive(chatId: string, text: string, buttons: Button[][]): Promise<ButtonResponse> {
    const agentId = parseGrokAgentId(chatId, this.relayAgentId);
    const widgetEntryId = this.pendingWidgets.get(agentId);
    if (widgetEntryId) {
      this.pendingWidgets.delete(agentId);
      await this.gateway.command("respondToWidget", {
        entryId: widgetEntryId,
        value: text,
        agentId,
      }, this.pollAbort?.signal);
      // Grok widgets have no ClearClaw button callback. Empty value = timeout semantics.
      return { value: "" };
    }
    const prompt = formatInteractivePrompt(text, buttons);
    await this.sendMessage(chatId, prompt);
    return { value: "" };
  }

  async editMessage(_chatId: string, _handle: string, _text: string, _opts?: MessageOpts): Promise<void> {
    // No-op: Grok gateway has no edit-entry command in the v1 map.
  }

  async deleteMessage(_chatId: string, _handle: string): Promise<void> {
    // No-op: Grok gateway has no delete-entry command in the v1 map.
  }

  async pinMessage(_chatId: string, _handle: string): Promise<void> {
    // No-op: Grok gateway has no pin command in the v1 map.
  }

  async unpinAllMessages(_chatId: string): Promise<void> {
    // No-op: Grok gateway has no unpin command in the v1 map.
  }

  async updateStatus(_chatId: string, _text: string): Promise<void> {
    // No-op: no Grok analogue to Telegram pins / Slack topic.
  }

  async setTyping(_chatId: string, _isTyping: boolean): Promise<void> {
    // No-op: host has setSharedRoomTyping for shared rooms, not 1:1 seats.
  }

  async sendFile(_chatId: string, _buffer: Buffer, _filename: string, _opts?: SendFileOpts): Promise<void> {
    // TODO: host SAND_GATEWAY_COMMANDS includes uploadAttachment, but it is not
    // in the typed SDK wrappers (no documented multipart vs path body). v1 does
    // not invent that contract. Prefer host-local attachmentPaths on sendPrompt
    // when the file already lives on the Grok box.
    log.warn("[channel] Grok sendFile is a stub; uploadAttachment is not wired");
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    const agentId = parseGrokAgentId(chatId, this.relayAgentId);
    await this.gateway.command("reactToMessage", {
      entryId: messageId,
      emoji,
      agentId,
    }, this.pollAbort?.signal);
  }

  /**
   * Abort an in-flight Grok agent run. Wired from Orchestrator `/cancel`
   * via optional Channel.interrupt.
   */
  async interrupt(chatId: string): Promise<void> {
    const agentId = parseGrokAgentId(chatId, this.relayAgentId);
    await this.gateway.command("interruptAgentRun", { id: agentId }, this.pollAbort?.signal);
  }

  /**
   * Ingest a transcript page (used by the poller and by unit tests).
   * Startup snapshots pass emit=false so history is not replayed as inbound chat.
   */
  ingestTranscriptEntries(agentId: string, entries: unknown[], emit: boolean): GrokAssistantEntry[] {
    const current = this.cursors.get(agentId) ?? { seq: 0, ids: new Set<string>() };
    const { cursor, messages, widgetIds } = applyTranscriptEntries(entries, current, emit);
    this.cursors.set(agentId, cursor);
    if (emit && widgetIds.length > 0) {
      this.pendingWidgets.set(agentId, widgetIds[widgetIds.length - 1]!);
    }
    if (!emit) return messages;

    for (const entry of messages) {
      if (this.isOwnEcho(entry.text)) continue;
      this.emitInbound(agentId, entry);
    }
    return messages;
  }

  /** Test helper: current tail seq for an agent. */
  tailSeq(agentId: string): number {
    return this.cursors.get(agentId)?.seq ?? 0;
  }

  private emitInbound(agentId: string, entry: GrokAssistantEntry): void {
    const msg: InboundMessage = {
      chatId: grokChatId(agentId),
      chatType: "dm",
      origin: {
        kind: "user",
        user: { id: grokChatId(agentId), name: "Grok" },
      },
      text: entry.text,
      messageId: entry.id,
    };
    this.emit("message", msg);
  }

  private rememberPrompt(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.recentPrompts.push(trimmed);
    if (this.recentPrompts.length > RECENT_PROMPT_LIMIT) this.recentPrompts.shift();
  }

  private isOwnEcho(text: string): boolean {
    const trimmed = text.trim();
    return this.recentPrompts.includes(trimmed);
  }

  private async snapshotTails(): Promise<void> {
    for (const agentId of this.boundAgentIds) {
      try {
        const entries = await this.fetchTail(agentId);
        this.ingestTranscriptEntries(agentId, entries, false);
      } catch (err) {
        log.warn({ err }, "[channel] Grok tail snapshot failed for %s", agentId);
        this.cursors.set(agentId, { seq: 0, ids: new Set() });
      }
    }
  }

  private startPoller(): void {
    this.pollTimer = setInterval(() => {
      this.pollTails().catch((err) => {
        log.warn({ err }, "[channel] Grok tail poll failed");
      });
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private async pollTails(): Promise<void> {
    if (!this.connected) return;
    for (const agentId of this.boundAgentIds) {
      const entries = await this.fetchTail(agentId);
      this.ingestTranscriptEntries(agentId, entries, true);
    }
  }

  private async fetchTail(agentId: string): Promise<unknown[]> {
    const body = { id: agentId, limit: this.tailLimit };
    try {
      const payload = await this.gateway.command("getAgentTranscriptTail", body, this.pollAbort?.signal);
      return unwrapTranscriptEntries(payload);
    } catch (err) {
      if (err instanceof GrokGatewayError && err.status === 404) {
        const fallback = await this.gateway.command("getAgentTranscript", { id: agentId }, this.pollAbort?.signal);
        return unwrapTranscriptEntries(fallback);
      }
      throw err;
    }
  }

  private async runSseLoop(): Promise<void> {
    while (this.connected && this.sseAbort && !this.sseAbort.signal.aborted) {
      try {
        const res = await this.gateway.openEvents(this.sseAbort.signal);
        if (!res.ok || !res.body) {
          log.warn("[channel] Grok SSE not available (%s)", res.status);
          await sleep(SSE_RETRY_MS, this.sseAbort.signal);
          continue;
        }
        await this.readSse(res.body, this.sseAbort.signal);
      } catch (err) {
        if (!this.connected || this.sseAbort?.signal.aborted) return;
        log.warn({ err }, "[channel] Grok SSE disconnected; retrying");
        await sleep(SSE_RETRY_MS, this.sseAbort.signal).catch(() => {});
      }
    }
  }

  private async readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = body.getReader();
    if (signal.aborted) {
      await reader.cancel().catch(() => {});
      return;
    }
    const onAbort = (): void => {
      reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const block of parts) this.handleSseBlock(block);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {
        reader.releaseLock();
      } catch {
        // cancel() already released the lock
      }
    }
  }

  private handleSseBlock(block: string): void {
    const event = parseSseBlock(block);
    if (!event) return;
    // SSE is liveness/busy only — never treat payloads as chat text.
    const payload = asRecord(event.payload);
    const busy = payload && typeof payload.isBusy === "boolean" ? payload.isBusy : undefined;
    log.debug(
      { channel: event.channel, busy },
      "[channel] Grok SSE %s",
      event.channel,
    );
  }
}

function formatInteractivePrompt(text: string, buttons: Button[][]): string {
  const labels = buttons.flat().map((b) => `- ${b.label} (${b.value})`);
  if (labels.length === 0) return text;
  return `${text}\n\nChoices:\n${labels.join("\n")}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}
