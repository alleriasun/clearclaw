# ClearClaw — Architecture

Transparent relay between chat channels and CLI agents. See [OVERVIEW.md](OVERVIEW.md) for strategy and rationale.

## Concepts

| Term | What it is | Scope |
|------|-----------|-------|
| **Bot** | A chat platform identity (token, username). The transport-layer messenger. E.g., a Telegram bot, a Slack app. | One per ClearClaw instance |
| **Agent** | An engine personality — defined by configuration in a workspace's `cwd` (e.g., CLAUDE.md, skills, permissions, MCP config for Claude Code). ClearClaw does not model agents; the engine does. | Lives in the workspace's `cwd` |
| **Channel** | A delivery channel — the platform adapter (Telegram, Slack, etc.) that handles sending/receiving messages, buttons, and typing indicators. | One per platform per instance |
| **Chat** | A conversation on a platform — a Telegram group, a DM, a Slack channel. Identified by `chat_id` with a platform prefix (e.g., `tg:123456`, `slack:C1234`). Platform names differ (Telegram "group", Slack "channel") but ClearClaw calls them all "chats". | Many per instance |
| **Workspace** | A named work context: `cwd` + session + chat binding. The unit of isolation within an instance. | One per chat, many per instance |
| **ClearClaw Instance** | One running process: one bot, one owner, multiple workspaces. | Process-level |

**Bot ≠ Agent.** A bot is a platform identity. An agent is defined by what's in the workspace's `cwd` — same bot, different cwd, different agent behavior. ClearClaw doesn't model agents. It routes messages to engines pointed at workspaces, and the engine picks up whatever configuration is in that directory.

**Multi-bot = multi-instance.** Separate bots, owners, or teams run separate ClearClaw processes with separate `CLEARCLAW_HOME` directories. No in-process multi-bot routing needed.

**Personal assistant, not shared bot.** The current model assumes one owner per instance — DMs go to the owner's home workspace, groups are collaborative spaces the owner invites others into. A team/shared bot model (where non-owners DM the bot with their own workspaces) is a different product shape, not currently in scope.

## Workspace Model

A **workspace** is a named unit defined by a working directory (CWD).

- **Home workspace** (`default`): The bot's home — personal assistant context for general questions, life management, system tasks. Lives at `~/.clearclaw/workspace/` (singular). Has its own `CLAUDE.md`, identity files, memory, skills. DM chat routes here.
- **Project workspaces** (user-defined, e.g., `myapp`, `work-api`): CWD is any directory on the machine (e.g., `~/projects/myapp`). The agent runs there with full access to the codebase. The project's own `CLAUDE.md` and `.claude/settings.json` apply naturally — same as a terminal session. Each project workspace maps to a Telegram group.

**Why singular `workspace/`, not `workspaces/default/`?** Project workspaces don't need a ClearClaw-managed directory — they point to existing repos. The only workspace that needs a managed home is the personal one, and there's only ever one (one bot, one user, one DM). Multiple identities would mean multiple bot deployments, not multiple directories. Keeping it singular also gives a clean mental model: the bot has a home (`workspace/`) and visits projects (external repos).

Each workspace is a row in SQLite:

| Field | Description |
|-------|-------------|
| `name` | Unique identifier (e.g., `default`, `myapp`) |
| `cwd` | Absolute path to working directory |
| `session_id` | Current Claude Code session ID |
| `chat_id` | The chat (Telegram group, DM, Slack channel, etc.) mapped to this workspace |

## File Structure

```
src/
  index.ts              # Entry point, orchestrator wiring, starts bot
  orchestrator.ts       # Message routing, turn management
  types.ts              # Channel, Engine, Workspace, event types
  config.ts             # Env vars → typed config object
  db.ts                 # SQLite: workspaces table
  format.ts             # Message formatting (tool descriptions, diffs)
  prompt.ts             # Prompt assembly (framework + user → system prompt)
  engine/
    claude-code.ts      # Claude Code SDK wrapper
  channel/
    telegram.ts         # grammY Telegram bot
    slack.ts            # Slack Bolt (Socket Mode)
```

## Data Flow

```
Chat message (Telegram / Slack)
  → Channel emits "message" event
  → Orchestrator.handleMessage()
  → looks up workspace by chat_id
  → ClaudeCodeEngine.runTurn()
  → SDK query() with prompt, CWD, optional resume
  → SDK yields SDKMessages (assistant text, tool calls, result)
  → Engine yields EngineEvents (text, tool_use, tool_result, done, error)
  → Orchestrator accumulates text, sends intermediate chunks
  → Channel.sendMessage()
```

## Permission Flow

```
SDK calls canUseTool(toolName, input)
  → Engine calls onPermissionRequest callback
  → Orchestrator calls Channel.sendInteractive()
  → User taps Allow/Deny button (inline keyboard / Block Kit)
  → Promise resolves with button value
  → Engine returns PermissionResult to SDK
```

Permission modes are relayed, not owned:

| Mode | Behavior |
|------|----------|
| `default` | Each tool use → chat buttons (Allow / Deny) |
| `acceptEdits` | Auto-approves file edits, asks for everything else |
| `plan` | Plan summary → Approve/Reject buttons |
| `bypassPermissions` | All tools auto-approved, no relay needed |

Permission config is also native — the CLI loads `settings.json` hierarchically (`~/.claude/settings.json` → `{cwd}/.claude/settings.json` → `{cwd}/.claude/settings.local.json`). The relay doesn't touch these.

## Claude Code SDK Settings

The Agent SDK does **not** load filesystem settings (CLAUDE.md, settings.json) by default — unlike the CLI, which loads them all automatically. The SDK defaults to isolation mode (`settingSources: []`).

To match CLI behavior, pass `settingSources: ["user", "project", "local"]` in `query()` options:

| Source | What it loads |
|--------|-------------|
| `"user"` | `~/.claude/settings.json` |
| `"project"` | `{cwd}/.claude/settings.json` + `CLAUDE.md` files |
| `"local"` | `{cwd}/.claude/settings.local.json` |

Order does not matter — all specified sources are loaded additively. If both project and user CLAUDE.md files exist, the agent sees both.

Other notable SDK `query()` options beyond what ClearClaw currently uses:

| Option | Type | Description |
|--------|------|-------------|
| `model` | `string` | Override model (e.g. `claude-sonnet-4-6`) |
| `maxTurns` | `number` | Max conversation turns before stopping |
| `maxBudgetUsd` | `number` | Budget cap in USD |
| `effort` | `'low' \| 'medium' \| 'high' \| 'max'` | Response effort level |
| `thinking` | `ThinkingConfig` | `{ type: 'adaptive' }`, `{ type: 'enabled', budgetTokens: N }`, or `{ type: 'disabled' }` |
| `additionalDirectories` | `string[]` | Extra directories Claude can access |
| `allowedTools` / `disallowedTools` | `string[]` | Auto-allow or remove specific tools |
| `mcpServers` | `Record<string, McpServerConfig>` | MCP server configurations |
| `betas` | `SdkBeta[]` | Beta features (e.g. `'context-1m-2025-08-07'`) |
| `debug` | `boolean` | Enable debug logging |
| `stderr` | `(data: string) => void` | Callback for stderr output (useful with `debug: true`) |

## Prompt Assembly

`assemblePrompt()` in `src/prompt.ts` reads `.md` files from two directories per-turn and concatenates them into a single string:

- **`prompts/`** (framework, bundled in repo) — `SYSTEM.md` (core behavior) + `ONBOARDING.md` (workspace setup flow)
- **`~/.clearclaw/workspace/instructions/`** (user, all optional) — `IDENTITY.md`, `USER.md`, `TOOLS.md`

Framework content first, user content appended. Applied to all workspaces. Files read fresh every turn — edits take effect on the next message.

**Claude Code engine delivery:** The assembled string is passed via `systemPrompt: { type: "preset", preset: "claude_code", append: <assembled> }`. The `preset` keeps all standard Claude Code behavior (including `settingSources`-loaded CLAUDE.md files). The `append` adds assembled content on top. Other engines will deliver the same assembled string through their own mechanism.

**System prompt layering** (Claude Code, additive):

1. Claude Code preset (base system prompt)
2. `~/.claude/CLAUDE.md` — user-level coding conventions (`settingSources: ["user"]`)
3. `{cwd}/CLAUDE.md` — project-specific instructions (`settingSources: ["project"]`)
4. Assembled prompt — framework + user content (`systemPrompt.append`)

## Session Management

Sessions are scoped to workspace (CWD), not channel.

Claude Code stores sessions at `~/.claude/projects/{encoded-cwd-path}/sessions/`. We store the active `session_id` per workspace in SQLite.

- **Terminal-mobile handoff:** A terminal session and a mobile session for the same CWD share the same session store. Start in the terminal, continue via Telegram, pick it back up in the terminal.
- **Session commands:** `/new` clears the stored session ID. Default behavior is resume.
- **Turn isolation:** One message at a time per workspace. Concurrent turns across different workspaces are allowed.

## User Identity

Channels populate structured user info (`UserInfo`) on every inbound message: a display `name` (always present) and an optional platform `handle` (e.g., Telegram username, no `@` prefix).

**When identity is included:** For group workspaces (non-default), the orchestrator prepends sender identity to the prompt: `[Sam (@sambot)]: the message`. This lets Claude distinguish speakers in multi-user group chats.

**When identity is skipped:** For the default (home/DM) workspace, the prompt passes through unchanged — it's always the owner talking, so identity context is noise.

**Layering:** The channel reports structured identity. The orchestrator decides whether to include it based on workspace type. The engine receives a plain prompt string either way — no `UserInfo` leaks into the engine interface.

**Deferred:** Explicit chat type (`dm` | `group`) on `InboundMessage` and owner detection were both considered. Workspace type is a sufficient discriminator for now — the home workspace is always a DM, project workspaces are always groups. If that stops holding, chat type is easy to add (channels know natively). User identity could also flow into workspace metadata for participant memory over time, but currently it's per-message only.

## Key Interfaces

Defined in `src/types.ts`. Two interfaces keep the orchestrator decoupled from specific channels and engines:

- **Channel** — EventEmitter. `connect`/`disconnect`, `sendMessage`, `sendInteractive` (buttons), `setTyping`. Emits `"message"` events with `InboundMessage` (includes `UserInfo`). Each channel owns a prefix namespace (`tg:`, `slack:`) and implements `ownsId()` for routing.
- **Engine** — `runTurn()` returns `AsyncIterable<EngineEvent>`. The orchestrator iterates events and routes them to the channel.
- **Workspace** — `name`, `cwd`, `chat_id`, `current_session_id`
- **UserInfo** — `name` (display name, always present), `handle` (optional platform handle). Populated by the channel from platform-native user data.

## Message Patterns

The relay translates a stream of engine events (tool calls, results, text, permission prompts) into a chat-friendly UX. These patterns balance visibility with noise.

### Message limits

Both Telegram (4096 chars) and Slack (4000 chars, 3000 for Block Kit section text) enforce per-message size limits. This bites hardest on permission prompts with large diffs — an Edit with a 200-line diff easily exceeds the limit. Current approach: `splitMessage()` chunks at the boundary. Future: consider sending diffs in a more surgical/collapsible way rather than dumping the whole thing.

### Rolling tool messages

A single turn can trigger many tool calls. Rather than one message per call, the relay maintains a single "rolling" message that gets edited on each `tool_use` event with the current tool's status. When the turn completes, the message is edited to a summary showing per-tool call counts (e.g., `🔧 3× Read, 2× Grep, 1× Bash`).

### Tool result suppression

All tool results are suppressed — the agent summarizes them in its text response. The engine yields `tool_result` events but the orchestrator discards them.

### Permission prompts

Tiered by tool type:
- **Edit/Write:** Rich preview — unified diff or full file content in a code block.
- **Everything else:** Header + key detail (command, pattern, query, URL) in a code block. Falls back to JSON-serialized input for unknown tools.

All prompts use a consistent `🔐 Allow {ToolName}?` header. Buttons offer Allow, Deny, and Deny + Note (feedback passed back to the agent so it can adjust). After a button is pressed, the selected button is highlighted with a ✅ prefix and the remaining buttons become inert. Deny + Note opens a follow-up input — Telegram uses `force_reply`, Slack opens a modal (`views.open`).

### Status message

A persistent message (pinned where supported) showing current model, context usage, and permission mode. Updated at the end of each turn. Stale status messages from previous server runs are cleaned up on first update.

## Channel Implementations

Both channels implement the same `Channel` interface but differ in platform specifics:

| Concern | Telegram | Slack |
|---------|----------|-------|
| **Transport** | grammY, long-polling | Bolt, Socket Mode |
| **Message limit** | 4096 chars | 3000 chars (Block Kit section.text is the binding constraint) |
| **Splitting** | `splitMessage()` at 4096 | `splitMessage()` at 3000 |
| **Rich formatting** | Markdown via `parse_mode` | Block Kit sections (mrkdwn) + plain `text` fallback |
| **Typing indicator** | Native `sendChatAction("typing")` | Posts italic "typing…" placeholder; persists through tool calls, consumed by first text response (`consumeTyping` flag) |
| **Buttons** | Inline keyboard (callback queries) | Block Kit action buttons |
| **Message handles** | `message_id` (number as string) | `ts` (timestamp string) |
| **Topic/description** | `setDescription` (groups) | `setTopic` (channels), auto-deletes system messages |

**Slack dual-field note:** Slack messages send both `text` (plain fallback for notifications/accessibility) and `blocks` (rich-rendered Block Kit). Both currently receive the same mrkdwn-formatted content. Slack renders mrkdwn in both fields, so there's no formatting mismatch for text content. If we ever need divergent formatting (e.g., stripping markdown from the `text` fallback), the split point is in `sendMessage` / `editMessage`.

## Storage

- `~/.clearclaw/workspace/` — The bot's home. User instruction files in `instructions/`, memory in `memory/` (daily notes + curated `MEMORY.md`), knowledge in `knowledge/`. Singular — only the personal/default workspace lives here; project workspaces point to existing repos.
- `~/.clearclaw/clearclaw.db` — SQLite: workspaces table (routing: chat → cwd + session)
- `~/.clearclaw/clearclaw.log` — Daemon log (console + file dual output)
- `~/.claude/projects/...` — Session data (owned by Claude Code, not us)

## Config

Environment variables:

**Channel (one required):**
- `TELEGRAM_BOT_TOKEN` — Telegram bot token (mutually exclusive with Slack)
- `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` — Slack bot + app-level token for Socket Mode. If both Slack and Telegram tokens are set, Slack takes priority.

**General:**
- `ALLOWED_USER_IDS` (required) — comma-separated, channel-prefixed user IDs (e.g. `tg:12345,slack:U67890`). Trust boundary. `ALLOWED_USER_ID` accepted as single-user alias.
- `PERMISSION_MODE` (optional, defaults to `default`)
- `CLEARCLAW_HOME` (optional, defaults to `~/.clearclaw`) — data directory for DB, logs. Use separate values for multi-instance isolation.
