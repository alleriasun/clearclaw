import type { McpServerConfig, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

// --- Channel ---

export interface ChannelEvents {
  message: [msg: InboundMessage];
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ownsId(chatId: string): boolean;
  sendMessage(
    chatId: string,
    text: string,
    opts?: MessageOpts,
  ): Promise<string[]>;
  sendInteractive(
    chatId: string,
    text: string,
    buttons: Button[][],
  ): Promise<ButtonResponse>;
  editMessage(chatId: string, handle: string, text: string, opts?: MessageOpts): Promise<void>;
  deleteMessage(chatId: string, handle: string): Promise<void>;
  pinMessage(chatId: string, handle: string): Promise<void>;
  unpinAllMessages(chatId: string): Promise<void>;
  updateStatus(chatId: string, text: string): Promise<void>;
  setTyping(chatId: string, isTyping: boolean): Promise<void>;
  sendFile(chatId: string, buffer: Buffer, filename: string, opts?: SendFileOpts): Promise<void>;
  reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void>;
  on<K extends keyof ChannelEvents>(event: K, listener: (...args: ChannelEvents[K]) => void): this;
  off<K extends keyof ChannelEvents>(event: K, listener: (...args: ChannelEvents[K]) => void): this;
  emit<K extends keyof ChannelEvents>(event: K, ...args: ChannelEvents[K]): boolean;
}

export interface Button {
  label: string;
  value: string;
  requestText?: boolean; // prompt for follow-up text after press
}

export interface ButtonResponse {
  value: string; // button value or '' on timeout
  text?: string; // user-provided follow-up text (when requestText button pressed)
}

export type TextFormat = "markdown" | "plain";

export interface MessageOpts {
  /** When false, skip consuming the typing placeholder (e.g. for tool status messages). */
  consumeTyping?: boolean;
  /** Reply/thread to a specific platform message ID (Telegram reply, Slack thread). */
  replyToMessageId?: string;
  /** Text format hint. Defaults to "markdown". */
  format?: TextFormat;
}

export interface SendFileOpts {
  caption?: string;
  mimeType?: string;
}

// --- Engine ---

export interface SessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  gitBranch?: string;
}

export interface Engine {
  name: string;
  runTurn(opts: RunTurnOpts): AsyncIterable<EngineEvent>;
  listSessions(cwd: string): Promise<SessionInfo[]>;
}

export interface RunTurnOpts {
  sessionId: string | null; // null = new session
  cwd: string;
  prompt: string;
  attachments?: Attachment[];
  permissionMode: PermissionMode;
  onPermissionRequest: (
    req: ToolCall,
  ) => Promise<PermissionResponse>;
  appendSystemPrompt?: string;
  mcpServers?: Record<string, McpServerConfig>;
  signal?: AbortSignal;
}

interface ToolCallBase {
  toolName: string;
  toolUseId: string;
}

const ACTIONS = {
  edit: "edit",
  write: "write",
  execute: "execute",
  read: "read",
  search: "search",
  fetch: "fetch",
} as const;

export type KnownToolCall =
  | (ToolCallBase & { action: typeof ACTIONS.edit; path: string; before: string; after: string })
  | (ToolCallBase & { action: typeof ACTIONS.write; path: string; content: string })
  | (ToolCallBase & { action: typeof ACTIONS.execute; command: string })
  | (ToolCallBase & { action: typeof ACTIONS.read; paths: string[] })
  | (ToolCallBase & { action: typeof ACTIONS.search; pattern: string; paths?: string[] })
  | (ToolCallBase & { action: typeof ACTIONS.fetch; url: string });

export interface UnknownToolCall extends ToolCallBase {
  action: string;
  [key: string]: unknown;
}

export type ToolCall = KnownToolCall | UnknownToolCall;

const knownActions = new Set<string>(Object.values(ACTIONS));

export function isKnownToolCall(tool: ToolCall): tool is KnownToolCall {
  return knownActions.has(tool.action);
}

export interface PermissionResponse {
  decision: "allow" | "deny";
  message?: string; // optional feedback on deny (skips abort, lets model adjust)
  updatedInput?: Record<string, unknown>;
}

export interface TurnStats {
  model: string | null;    // e.g. "claude-opus-4-6", null for ACP engines
  contextUsed: number;     // input tokens of last API call (≈ context fill)
  contextWindow: number;   // max context window size
  toolCalls: Record<string, number>; // tool name → call count for this turn
}

export type EngineEvent =
  | { type: "text"; text: string }
  | { type: "text_chunk"; text: string }
  | { type: "tool_use"; tool: ToolCall }
  | { type: "tool_result"; toolName: string; output: string }
  | { type: "rate_limit"; status: string; resetsAt?: number }
  | { type: "done"; sessionId: string; stats?: TurnStats }
  | { type: "error"; message: string };

// --- Workspace ---

export interface Workspace {
  name: string;
  cwd: string;
  chat_id: string;
  current_session_id: string | null;
  behavior?: "assistant" | "relay";
  engine?: string;         // "claude-code" (default) | "kiro" | other ACP agent
}

// --- User identity (populated by channel from platform data) ---

export interface UserInfo {
  id: string;       // platform-prefixed ID (e.g. "tg:79xxx")
  name: string;
  handle?: string;  // platform handle, no @ prefix (e.g. Telegram username)
}

// --- Attachments ---

/** File data from a channel, kept in memory for engine consumption. */
export interface Attachment {
  buffer: Buffer;
  mimeType: string;
  filename?: string;
}

// --- Inbound message (from channel to orchestrator) ---

/** Context from a replied-to / quoted message. */
export interface ReplyContext {
  messageId: string;
  senderName?: string;
  text?: string;
  mediaType?: string;
}

export type ChatType = "dm" | "group";


export interface InboundMessage {
  chatId: string;
  chatType: ChatType;
  user: UserInfo;
  text: string;
  messageId?: string;
  replyTo?: ReplyContext;
  attachments?: Attachment[];
}

export type { PermissionMode };
