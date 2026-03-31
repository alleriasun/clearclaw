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
    opts?: SendMessageOpts,
  ): Promise<string[]>;
  sendInteractive(
    chatId: string,
    text: string,
    buttons: Button[][],
  ): Promise<ButtonResponse>;
  editMessage(chatId: string, handle: string, text: string): Promise<void>;
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

export interface SendMessageOpts {
  parseMode?: "MarkdownV2" | "HTML";
  /** When false, skip consuming the typing placeholder (e.g. for tool status messages). */
  consumeTyping?: boolean;
  /** Reply/thread to a specific platform message ID (Telegram reply, Slack thread). */
  replyToMessageId?: string;
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
    req: PermissionRequest,
  ) => Promise<PermissionResponse>;
  appendSystemPrompt?: string;
  mcpServers?: Record<string, McpServerConfig>;
  signal?: AbortSignal;
}

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  reason?: string;
  toolUseId: string;
}

export interface PermissionResponse {
  decision: "allow" | "deny";
  message?: string; // optional feedback on deny (skips abort, lets model adjust)
  updatedInput?: Record<string, unknown>;
}

export interface TurnStats {
  model: string;           // e.g. "claude-opus-4-6"
  contextUsed: number;     // input tokens of last API call (≈ context fill)
  contextWindow: number;   // max context window size
  toolCalls: Record<string, number>; // tool name → call count for this turn
}

export type EngineEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; toolName: string; input: Record<string, unknown>; toolUseId: string }
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

export interface InboundMessage {
  chatId: string;
  user: UserInfo;
  text: string;
  messageId?: string;
  replyTo?: ReplyContext;
  attachments?: Attachment[];
}

export type { PermissionMode };
