import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

// --- Channel ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ownsId(channelId: string): boolean;
  sendMessage(
    channelId: string,
    text: string,
    opts?: SendMessageOpts,
  ): Promise<void>;
  sendInteractive(
    channelId: string,
    text: string,
    buttons: Button[],
  ): Promise<ButtonResponse>;
  setTyping(channelId: string, isTyping: boolean): Promise<void>;
}

export interface Button {
  label: string;
  value: string;
}

export interface ButtonResponse {
  value: string; // button value or '' on timeout
}

export interface SendMessageOpts {
  parseMode?: "MarkdownV2" | "HTML";
}

// --- Engine ---

export interface Engine {
  name: string;
  runTurn(opts: RunTurnOpts): AsyncIterable<EngineEvent>;
}

export interface RunTurnOpts {
  sessionId: string | null; // null = new session
  cwd: string;
  prompt: string;
  permissionMode: PermissionMode;
  onPermissionRequest: (
    req: PermissionRequest,
  ) => Promise<PermissionResponse>;
  signal?: AbortSignal;
}

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  reason?: string;
}

export interface PermissionResponse {
  decision: "allow" | "deny";
}

export type EngineEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; toolName: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolName: string; output: string }
  | { type: "rate_limit"; status: string; resetsAt?: number }
  | { type: "done"; sessionId: string }
  | { type: "error"; message: string };

// --- Workspace ---

export interface Workspace {
  name: string;
  cwd: string;
  channel_id: string;
  current_session_id: string | null;
}

// --- Inbound message (from channel to orchestrator) ---

export interface InboundMessage {
  channelId: string;
  text: string;
}

export type { PermissionMode };
