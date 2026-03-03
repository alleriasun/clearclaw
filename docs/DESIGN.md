# ClearClaw — Design

Implementation design for the relay daemon. Strategy and rationale live in [OVERVIEW.md](OVERVIEW.md).

---

## Relay Principle

ClearClaw is a **transparent relay**, not an agent frontend. It routes interactions between a chat channel and the CLI without duplicating CLI functionality.

**ClearClaw does NOT:**
- Own a permission system (the CLI has one)
- Have its own tool allowlist (the CLI has one)
- Have its own MCP config (the CLI has one)
- Manage memory or context (the CLI does this via sessions and CLAUDE.md)
- Own the system prompt (CLAUDE.md lives in the user's project)

**ClearClaw DOES:**
- Route CLI permission prompts → chat buttons (Allow / Deny / Allow for session)
- Route CLI AskUserQuestion → chat option menus
- Route CLI plan approval → chat Approve/Reject buttons
- Route CLI output → formatted chat messages
- Route user input → CLI prompt
- Map channels to workspaces (channelId → CWD)
- Map channels to sessions (channelId → sessionId)

This is the single most important design constraint. When in doubt about where logic belongs, the answer is: in the CLI, not in ClearClaw.

---

## Workspace Model

A **workspace** is a named unit defined by a working directory (CWD).

- **Personal assistant context** (`main`): General questions, life management, system tasks. CWD is the project's own data directory. Has its own `CLAUDE.md` for personal memory (preferences, habits, recurring context).
- **Project contexts** (user-defined, e.g., `myapp`, `work-api`): CWD is any directory on the machine (e.g., `~/projects/myapp`). The agent runs there with full access to the codebase. The project's own `CLAUDE.md` and `.claude/settings.json` apply naturally — same as a terminal session.

Each workspace is a row in SQLite:

| Field | Description |
|-------|-------------|
| `name` | Unique identifier (e.g., `main`, `myapp`) |
| `cwd` | Absolute path to working directory |
| `session_id` | Current Claude Code session ID |
| `channel_id` | The chat/channel/group mapped to this workspace |

This is NanoClaw's model. NanoClaw stores equivalent data in SQLite with `groups` as the table name and `chatJid` as the channel identifier.

---

## Interfaces

Two interfaces keep the orchestrator decoupled from specific channels and engines. Minimal — only the methods actually needed. Future phases add methods, not redesign.

### Channel

Derived from NanoClaw's `Channel` interface (used across WhatsApp, Telegram, Discord, Slack). Extended with `sendInteractive()` for permission relay — NanoClaw doesn't need this because it runs `bypassPermissions` inside containers.

```typescript
interface Channel {
  readonly name: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Route: does this channel own the given channel ID?
  // Prefix namespacing: tg:123, slack:C123, dc:456
  ownsId(channelId: string): boolean;

  // Outbound
  sendMessage(channelId: string, text: string): Promise<void>;
  sendInteractive(channelId: string, text: string, buttons: Button[]): Promise<string>;
  setTyping(channelId: string, isTyping: boolean): Promise<void>;

  // Inbound — callback-based
  // Set during construction, not part of the interface methods
  // onMessage: (channelId: string, message: InboundMessage) => void
  // onButtonPress: (channelId: string, callbackId: string, value: string) => void
}

interface Button {
  label: string;
  value: string;
}

interface InboundMessage {
  id: string;
  channelId: string;
  sender: string;
  senderName: string;
  text: string;
  timestamp: string;
}
```

**Channel ID namespacing** (from NanoClaw): Each channel owns a prefix. `tg:123456` for Telegram, `slack:C1234567890` for Slack. The orchestrator calls `ownsId()` to route outbound messages to the right channel.

**Interactive messages per channel:**
- **Telegram:** Inline keyboards (buttons below message). remotecode already does this for permission relay.
- **Slack:** Block Kit `actions` blocks with buttons. Clicks arrive as `interaction` events on the Socket Mode WebSocket.

### Engine

Shape borrowed from OpenClaw's `AcpRuntime` interface (`ensureSession()` + `runTurn()` → streaming events), simplified. The implementation for Claude Code wraps remotecode's SDK integration (query, canUseTool, turn locking, stale detection).

```typescript
interface Engine {
  readonly name: string;

  ensureSession(opts: {
    sessionId: string | null;
    cwd: string;
  }): Promise<string>; // returns sessionId

  runTurn(opts: {
    sessionId: string;
    prompt: string;
    permissionMode: PermissionMode;
    onPermissionRequest: (req: PermissionRequest) => Promise<PermissionResponse>;
    onAskUser: (req: AskUserRequest) => Promise<string>;
    signal?: AbortSignal;
  }): AsyncIterable<EngineEvent>;

  cancel(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
}

type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

type EngineEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; tool: string; description: string }
  | { type: 'done'; sessionId: string }
  | { type: 'error'; message: string };
```

**How this maps to implementations:**

| | Claude Code (Phase 1) | Kiro CLI (Phase 3) |
|---|---|---|
| `ensureSession` | Check JSONL exists → `resume` or new `sessionId` | `kiro-cli acp` → `initialize` + `session/new` or `session/load` |
| `runTurn` | SDK `query()` with `canUseTool` callback | JSON-RPC `session/prompt` → stream `AgentMessageChunk`/`ToolCall`/`TurnEnd` events |
| `cancel` | `AbortSignal` | JSON-RPC `session/cancel` |
| `close` | `channel.close()` + `query.close()` | Close stdin pipe |
| Turn locking | remotecode's `turnLock` Promise pattern | JSON-RPC is naturally sequential |
| Stale detection | JSONL file size comparison (remotecode pattern) | Not needed (no shared session file) |

---

## Permission Relay

No custom permission system. We relay Claude Code's native modes over the chat channel.

The SDK exposes four `permissionMode` values plus a `canUseTool` callback for per-tool interception:

| CC Native Mode | What it does | How we relay it |
|---|---|---|
| `default` | Interactive — each tool use prompts for approval | Route each prompt to chat as buttons (Allow / Deny / Allow for session). remotecode's existing pattern. |
| `acceptEdits` | Auto-approves file edits, asks for everything else | Same relay, fewer prompts. Good default for project contexts. |
| `plan` | Agent proposes plan first, user approves before execution | Route plan summary to chat, Approve/Reject buttons. On approve, execution proceeds with approved scope. |
| `bypassPermissions` | All tools auto-approved (requires `allowDangerouslySkipPermissions` flag) | No relay needed — agent runs autonomously. Post summary of actions after each turn. |

The user picks a mode per workspace. The personal assistant workspace (`main`) might run `bypassPermissions`. A project workspace might use `default` or `plan`. The relay layer maps `canUseTool` invocations to `channel.sendInteractive()` calls and resolves the callback with the user's button press. Timeout (5 min) defaults to deny.

**Permission config** is also native. The CLI loads `settings.json` rules hierarchically:

```
~/.claude/settings.json            # Global baseline
{cwd}/.claude/settings.json        # Project-scoped (shared)
{cwd}/.claude/settings.local.json  # Project-scoped (local, gitignored)
```

Rules use allow/deny with tool specifiers (`"Bash(git:*)"`, `"Read"`, etc.). Deny takes priority. The relay doesn't touch these — the agent loads them from the CWD like any terminal session.

---

## Session Management

Sessions are scoped to workspace (CWD), not channel.

Claude Code stores sessions at `~/.claude/projects/{encoded-cwd-path}/sessions/`. We store the active `session_id` per workspace in SQLite.

- **Terminal-mobile handoff:** A terminal session and a mobile session for the same CWD share the same session store. Start in the terminal, continue via Telegram, pick it back up in the terminal.
- **Stale detection** (from remotecode): Compare JSONL file size before each `runTurn`. If changed externally, mark session stale, close, recreate with `resume`. remotecode stores `lastFileSize` per `SessionState` and checks on every turn.
- **Session commands:** `/new` clears the stored session ID. `/sessions` lists past sessions. Default behavior is resume.
- **Turn locking** (from remotecode): One message at a time per session. Incoming messages during an active turn are queued and drained after the turn completes.

---

## Data Layout

User data lives in `~/.clearclaw/`, separate from application source:

```
~/.clearclaw/
  clearclaw.db          # SQLite: contexts, scheduled tasks
  logs/               # Daemon logs
```

Session data stays in Claude Code's native location (`~/.claude/projects/...`). We don't duplicate or move it.

---

## Implementation Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Telegram library | grammY | Both NanoClaw and OpenClaw use it. remotecode's raw HTTP approach is the outlier. grammY gives us event system, inline keyboards, typing helpers without reinventing. |
| Message concurrency | Queue per workspace | User sends while agent is busy → queue, drain after turn. remotecode's pattern. Rejecting is hostile UX, appending mid-turn isn't supported by SDK. |
| Config (Phase 1) | Env vars | Just `TELEGRAM_BOT_TOKEN` and `ALLOWED_CHAT_ID`. No config file needed yet. |
| Interfaces | Define in Phase 1 | ~20 lines of type definitions. Phases 2-4 become additive (new files) instead of surgical (refactoring core). |
| Auth / provider per workspace | `extraArgs` in SDK (Phase 2) | SDK supports `extraArgs: { settings: "...", "mcp-config": "..." }` for per-workspace CLI overrides. Phase 1 uses host-level auth. Phase 2 adds per-workspace `extraArgs` so different workspaces can use different API providers or settings. |

---

## Open Questions

1. **Config format.** YAML or TOML? YAML is more familiar, TOML is stricter and avoids indentation bugs.
2. ~~**Kiro integration.**~~ **Resolved.** Use `kiro-cli acp` (Agent Client Protocol) — JSON-RPC 2.0 over stdin/stdout. No official JS SDK, but the ACP protocol is well-defined: `initialize`, `session/new`, `session/prompt`, `session/cancel` methods with streaming events (`AgentMessageChunk`, `ToolCall`, `TurnEnd`). ~200-300 LOC for a JSON-RPC client wrapper. Do NOT use `kiro-cli chat --no-interactive` (ANSI text, not parseable).
3. **Slack channel.** Slack requires a public endpoint for events API (or Socket Mode for no-server). Socket Mode is the right choice for a personal daemon but adds a dependency. Implementation details: mrkdwn formatting, Block Kit patterns, required scopes.
4. **Structured memory.** CLAUDE.md is enough for now. Is there a case for SQLite-backed memory with decay?
5. **Multi-user / channel portability.** Currently single-user with one channel per workspace. If this moves to a cloud/team deployment, multiple users could share a workspace via different channels (Telegram group + Slack channel → same CWD). That's a multi-user feature, not a single-user one. Revisit if/when multi-user becomes relevant.

