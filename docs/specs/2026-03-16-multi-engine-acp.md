# Spec: Multi-engine support via ACP (Kiro + future engines)

**Status: Shipped.** Core implementation landed on main. See `docs/plans/2026-03-19-acp-engine-impl.md` for the build recipe.

## Context

ClearClaw's Phase 3 goal is supporting engines beyond Claude Code, starting with Kiro. Our Engine interface (`runTurn` + `listSessions`) was designed with this in mind, but we hadn't settled on how to actually talk to non-Claude engines.

We investigated the **Agent Client Protocol (ACP)**, a JSON-RPC 2.0 over stdio protocol for communicating with AI coding agents. ACP gives us a single integration path for any compliant agent. The primary target is **Kiro** (`kiro-cli acp`), with the architecture open to Codex, Cursor, and others.

We also evaluated **acpx** ([openclaw/acpx](https://github.com/openclaw/acpx)), a headless CLI wrapper around ACP. Decided against it: ClearClaw already handles the operational concerns acpx solves (prompt serialization, session persistence, process lifecycle), and the extra process layer adds complexity without value.

## ACP origins and ecosystem

ACP was created by **Zed Industries** (the Zed editor team), co-initiated with **Google's Gemini CLI team**. Announced August 27, 2025. Key people: Nathan Sobo (Zed CEO), Ben Brandt (Zed engineer).

**Anthropic is not involved.** Claude Code appears in the ACP agent registry only via `claude-agent-acp` — a wrapper Zed built, not an Anthropic product. There is an [open feature request (#6686)](https://github.com/anthropics/claude-code/issues/6686) for Claude Code to natively support ACP. Status: open, no commitment.

Ecosystem partners: Google (Gemini CLI — reference ACP implementation), JetBrains (adopting ACP across IntelliJ family), Block (Goose agent), Amazon (Kiro — native ACP).

Note: Anthropic created and donated **MCP** (Model Context Protocol) to the Linux Foundation — a distinct protocol for tool/resource integration, not agent-client communication.

References:
- [Zed ACP page](https://zed.dev/acp)
- [ACP protocol spec](https://agentclientprotocol.com/protocol/overview)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) — `ClientSideConnection` class, v0.16.1
- [Claude Code ACP feature request](https://github.com/anthropics/claude-code/issues/6686)

## Kiro ACP support

Confirmed. Kiro ships native ACP support via `kiro-cli acp`, announced February 5, 2026 ("Specialized IDEs deserve AI too: Kiro adopts ACP"). Stdio-based, standard ACP pattern.

Spawn config: `{ "command": "~/.local/bin/kiro-cli", "args": ["acp"] }`

Install: `curl -fsSL https://cli.kiro.dev/install | bash` → installs `kiro-cli` to `~/.local/bin/`.

Kiro's session store: `~/.kiro/sessions/cli/`. Identity injection via `~/.kiro/steering/*.md` steering files or `AGENTS.md` in workspace cwd.

## Research findings

### What ACP provides

ACP is JSON-RPC 2.0 over stdio. Core surface:

**Client → Agent:** `initialize`, `session/new` (cwd, mcpServers, _meta), `session/load` (resume by ID), `session/list` (discover by cwd), `session/prompt`, `session/cancel`, `session/set_mode`, `session/set_config_option`

**Agent → Client (callbacks):** `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `terminal/*`

**Agent → Client (notifications via `session/update`):**
- `agent_message_chunk` / `user_message_chunk` — streamed content via `ContentChunk` (contains `ContentBlock` + optional `_meta` + optional `messageId`)
- `agent_thought_chunk` — reasoning/thinking content
- `tool_call` — tool invocation with human-readable `title` field
- `tool_call_update` — tool execution status changes
- `plan` — agent's execution plan
- `current_mode_update` — mode changes pushed by agent
- `available_commands_update` — available commands/tools
- `config_option_update` — setting changes
- `usage_update` — `UsageUpdate` with context and cost telemetry (see below)

**Telemetry via `UsageUpdate`** (streamed during turns): `size` (context window tokens), `used` (tokens in context), `cost` (cumulative, optional/adapter-dependent). **`PromptResponse.usage`** (per-turn): `inputTokens`, `outputTokens`, `totalTokens`, `cachedReadTokens`, `cachedWriteTokens`, `thoughtTokens`. Not available: model name, rate limit events.

**Unstable methods on `ClientSideConnection`:** `unstable_forkSession()`, `unstable_resumeSession()`, `unstable_closeSession()`, `unstable_setSessionModel()`. Core surface is stable.

The adapter ecosystem: `claude-agent-acp` (Zed-built wrapper), `codex-acp`, `cursor-acp`, plus native ACP in Kiro CLI.

### Session ownership is agent-side

Key concern: can sessions started on desktop be resumed remotely through ClearClaw? Yes.

- Sessions are **agent-owned**. History lives in the agent's store (`~/.claude/projects/` for Claude, `~/.kiro/sessions/cli/` for Kiro). Client holds only a session ID reference.
- `session/load`: agent replays full conversation via `session/update` notifications. Client doesn't provide history.
- **No client-identity binding** on sessions. Any client with the session ID can resume.
- `session/list` allows discovery by cwd — ClearClaw can show sessions started on desktop.

Caveat: MCP tools from the original session must be re-declared by the resuming client. History is intact regardless.

### acpx specifics

acpx wraps ACP with operational concerns: auto-downloads adapters via `npx`, queue owner model (long-lived process serializes prompts via IPC), crash recovery (detects dead PIDs, respawns, attempts `session/load`), session metadata at `~/.acpx/sessions/`.

**Status: alpha.** Interfaces still changing.

## Gap analysis: SDK vs ACP for each ClearClaw feature

### Session management — no gaps

| Feature | SDK | ACP | Gap |
|---|---|---|---|
| Resume session | `query({ resume })` | `session/load(id)` | None |
| List sessions | `listSessions({ dir })` | `session/list({ cwd })` | None |
| New session | Omit `resume` | `session/new({ cwd })` | None |
| Cross-client resume | N/A | Agent-owned, any client can resume | ACP advantage |

### Permissions — partial gaps

| Feature | SDK | ACP | Gap |
|---|---|---|---|
| Permission callback | `canUseTool` → allow/deny/message | `session/request_permission` → approve/reject | Lose `updatedInput` modification |
| Deny + feedback | `{ behavior: "deny", message }` — model retries with guidance | Binary approve/reject | **Yes**: lose guided denial |
| Permission mode | `permissionMode: "acceptEdits"` | `session/set_mode(modeId)` | Adapter-defined, not standardized |
| Bypass permissions | `allowDangerouslySkipPermissions` | No standard equivalent | **Yes** |

### Status & telemetry — minor gaps

| Feature | SDK | ACP | Gap |
|---|---|---|---|
| Model name | `SDKResultMessage.model` | Not in ACP | **Yes**: use engine name instead |
| Context usage | `input_tokens + cache_read + cache_creation` | `UsageUpdate.used` | None |
| Context window | `SDKResultMessage.contextWindow` | `UsageUpdate.size` | None |
| Context % | Computed | Compute from `used / size` | None |
| Token breakdown | Via SDK message | `PromptResponse.usage` (input/output/cached/thought) | None |
| Tool call counts | Built from SDK events | Reconstruct from `tool_call` updates | None |
| Rate limit events | `SDKRateLimitEvent` | Not in ACP | **Yes**: agent handles internally |
| Cost tracking | `total_cost_usd` | `UsageUpdate.cost` (optional) | **Partial**: adapter-dependent |

Status is nearly at parity. The only visible difference: engine name ("kiro") replaces model name ("opus-4-6") in the status display.

### Identity & configuration — inherent engine limits

| Feature | SDK | ACP | Gap |
|---|---|---|---|
| System prompt append | `systemPrompt: { preset, append }` | Not in ACP | **Not bridgeable** |
| Settings sources | `settingSources: [...]` | Agent-internal | Can't control |
| Model selection | `query({ model })` | `unstable_setSessionModel()` | Unstable API |

Non-Claude engines don't have system prompt injection through *any* interface. This isn't an ACP gap — it's an engine gap. Workaround: filesystem-based identity injection via `AGENTS.md`, `~/.kiro/steering/*.md`, etc.

### Streaming — adequate

Text, tool calls, tool results, thinking all map with minor field name differences. ACP's `tool_call` events carry structured data: `kind` (edit/write/read/execute/search/fetch), `locations` (file paths with optional line numbers), and `content` (including diff blocks with old/new text). This maps well to ClearClaw's `ToolCall` discriminated union for rich permission prompts and tool status display. Token-level streaming preserved.

## Three-way comparison: Claude Agent SDK vs ACP TS SDK vs acpx

For non-Claude engines, we have two ACP options: use `@agentclientprotocol/sdk` (`ClientSideConnection`) directly as a library, or go through acpx as a CLI wrapper.

### ACP TS SDK (`@agentclientprotocol/sdk`)

TypeScript library. We'd implement the `Client` interface (callbacks for permissions, fs, terminal, session updates) and call `Agent` methods (newSession, loadSession, listSessions, prompt, cancel, setSessionMode). Spawn the agent process ourselves, pipe stdio through `ndJsonStream`.

Key API surface on `ClientSideConnection`: `initialize()`, `newSession()`, `loadSession()`, `listSessions()`, `prompt()`, `cancel()`, `setSessionMode()`, `unstable_setSessionModel()`, `setSessionConfigOption()`, `unstable_resumeSession()`, `unstable_forkSession()`.

`Client` interface we implement: `requestPermission()`, `sessionUpdate()`, plus optional `readTextFile()`, `writeTextFile()`, `createTerminal()`, etc.

### Comparison

| Concern | Claude Agent SDK | ACP TS SDK | acpx CLI |
|---|---|---|---|
| Integration | npm, in-process | npm, in-process, spawn agent via stdio | CLI subprocess or IPC |
| Type safety | Full TS types | Full TS types | Parse NDJSON ourselves |
| Process overhead | None (SDK is the agent) | One child (the agent) | Two (acpx + agent) |
| Session management | `query()`, `listSessions()` | `newSession()`, `loadSession()`, `listSessions()` | CLI commands |
| Session persistence | We manage | We manage | acpx manages |
| Crash recovery | We manage | We manage | acpx handles |
| Adapter spawning | N/A | We spawn + pipe stdio | acpx spawns + auto-downloads |
| Streaming | AsyncIterable of SDK events | `sessionUpdate` callback | NDJSON stream |
| Permissions | `canUseTool` with deny+feedback | `requestPermission` (approve/reject) | approve/reject |
| Model selection | `query({ model })` | `unstable_setSessionModel()` | `_meta` on session/new |
| Mode switching | `permissionMode` per query | `setSessionMode()` | `set-mode` command |
| System prompt | `systemPrompt: { preset, append }` | Not in protocol | Not in protocol |
| Telemetry | model, context, cost | context + cost via `UsageUpdate`; no model name | Same as ACP TS SDK |
| Session forking | Not available | `unstable_forkSession()` | Not exposed |

### ACP SDK vs acpx: the real tradeoff

**ACP SDK advantages:** In-process, typed, no extra process layer, full control over connection lifecycle, access to newer unstable methods (`setSessionModel`, `forkSession`, `resumeSession`). We already manage session persistence and crash recovery for Claude — same patterns apply.

**acpx advantages:** Adapter auto-download (don't need to know the npx command per agent), queue owner with crash recovery, session metadata store. Operational concerns solved.

**Our take:** ClearClaw already handles prompt serialization (busy guard), session persistence (workspaces.json), and process lifecycle. The ACP SDK gives us those protocol primitives directly as a typed library — we'd be adding the same patterns we already have for Claude. acpx's operational features overlap with what ClearClaw already does, and the extra process layer adds complexity.

## Design decision

**Direct Claude Agent SDK for Claude Code, ACP TS SDK (`@agentclientprotocol/sdk`) for Kiro and other ACP-compatible engines.**

- Claude Agent SDK gives 100% of our feature surface. ACP gives ~90% — the remaining gaps (model name, rate limits, rich permission deny+feedback) are real but minor.
- For Kiro and other engines, ACP gives everything they expose. Gaps are engine-inherent, not protocol-inherent.
- ACP TS SDK over acpx: typed in-process library, no extra process layer, same session/crash patterns we already use for Claude. acpx's operational features duplicate what ClearClaw already does.
- Engine interface maps cleanly to both: `runTurn()` → SDK `query()` or ACP `prompt()`.

Status nearly at parity for ACP engines — context % and cost display work via `UsageUpdate`. Model name replaced by engine name in status display. Identity injection via filesystem for non-Claude engines (only option available through any interface).

## Architecture (as shipped)

```
  Orchestrator (engines: Map<string, Engine>, engineFor(ws))
       |                         |
  ClaudeCodeEngine           AcpEngine
   (Agent SDK)              (ACP TS SDK)
       |                         |
  Claude Agent SDK      ClientSideConnection (ndJsonStream)
       |                         |
  Claude Code CLI          Agent process (kiro-cli acp, etc.)
```

**Engine selection:** Per-workspace via `workspace.engine` field (default: `config.defaultEngine`). Orchestrator's `engineFor(ws)` resolves from the engine map.

**Engine registry** (`src/engine/registry.ts`): Built-in map for known agents (`"kiro"` -> `{ command: "kiro-cli", args: ["acp"] }`). Exports `ENGINE_NAMES`, `engineCommand()`, and `createEngineMap(enginePaths)`.

**AcpEngine** (`src/engine/acp.ts`): Spawns agent process per turn, creates `ClientSideConnection`, implements `Client` interface. Structured tool calls via `ToolCall` discriminated union (edit/write/read/execute/search/fetch). Caches `tool_call` data in `pendingTools` for richer permission prompts. Negotiates image support via agent capabilities. Replay suppression via `live` flag. Cancellation via `conn.cancel()`.

**AsyncQueue** (`src/engine/async-queue.ts`): Bridges callback-based `sessionUpdate` to `AsyncIterable<EngineEvent>`.

**Streaming:** ACP text chunks emit as `text_chunk` events, enabling the orchestrator's edit-in-place streaming display.

**Setup** (`src/index.ts`): Engine selection from `ENGINE_NAMES`, PATH validation via `engineCommand()`, resolved executable paths stored in config.

## Convergence: will ACP replace the Claude Agent SDK?

Possible, but not imminent.

**For eventual consolidation:** ACP covers ~90% of what we use from the Claude Agent SDK. The gap is narrowing with each protocol version. If Claude Code ships native ACP, we'd have one protocol for all engines. One adapter is less code than two.

**Against rushing it:** Anthropic isn't behind ACP — native support is an open feature request, not a roadmap item. The SDK gives us things ACP can't: model name, rate limit relay, rich permission semantics (deny+feedback, `updatedInput`), `settingSources`, `systemPrompt` append. The SDK is in-process with no subprocess management; ACP for Claude would mean spawning Claude Code as a child process.

**Strategy:** Don't replace. Layer. The Engine interface protects us — two adapters is low maintenance cost. If/when Claude Code ships native ACP and the protocol closes the remaining gaps (model name, rate limits), switching is a one-file change.

## Open questions (status as of shipping)

1. **Permission deny+feedback for ACP** -- Still an inherent protocol gap. ACP is binary approve/reject; ClearClaw's "Deny + Note" feedback is dropped for ACP engines.

2. **Kiro permission semantics** -- Still needs end-to-end testing.

3. ~~**Readiness**~~ -- Resolved. Went directly to full build.

## Remaining limitations

**Fast follows (add when needed):**
- `listSessions` for ACP (spawn agent process for `/resume` discovery)
- Stats/telemetry (wire `usage_update` to context %, cost tracking)
- Mode translation (discover agent-native modes, call `setSessionMode()`)

**Inherent ACP gaps (not fixable):**
- No deny+feedback: ACP is binary approve/reject. "Deny + Note" note is dropped.
- No system prompt injection: use `AGENTS.md` in workspace cwd.
- No rate limit events: agent handles rate limits internally.

**Other:**
- No custom engine config: only hardcoded engines in registry.
- No UI to set workspace engine: manually edit `workspaces.json`.
- Hardcoded client version (`"0.4.0"`): should read from package.json.

## Files (shipped)

| File | Change |
|---|---|
| `src/types.ts` | `ToolCall` discriminated union, `engine?` on Workspace, `TurnStats.model` nullable, `text_chunk` event |
| `src/engine/acp.ts` | `AcpEngine` with structured tool mapping, image negotiation, `pendingTools` cache |
| `src/engine/async-queue.ts` | `AsyncQueue<T>` callback-to-AsyncIterable bridge |
| `src/engine/registry.ts` | Spawn configs, `ENGINE_NAMES`, `engineCommand()`, `createEngineMap(enginePaths)` |
| `src/engine/claude-code.ts` | Updated to emit `ToolCall` objects, accepts optional executable path |
| `src/orchestrator.ts` | Engine map, `engineFor(ws)`, `engineName` on ChatState, streaming text display |
| `src/index.ts` | Engine selection in setup, `createEngineMap(enginePaths)` with resolved paths |
| `src/format.ts` | `formatToolStatusLine()` and `formatPermissionPrompt()` for `ToolCall` union |
| `src/channel/telegram.ts` | Updated for `ToolCall`-based permission prompts |
| `src/channel/slack.ts` | Updated for `ToolCall`-based permission prompts |
| `src/config.ts` | Engine config storage (name/default/path) |
