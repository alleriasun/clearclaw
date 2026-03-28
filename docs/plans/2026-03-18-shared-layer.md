# Shared Layer — Design Plan

## Problem

ClearClaw manages multiple project workspaces, each with CLI-native config. Project-specific, shouldn't be touched. But identity, memory, hooks, permissions need to be shared across all. Challenge: inject additively.

## Key Questions to Verify

- [ ] Does SDK `--mcp-config` merge with project MCP servers or replace them?
- [ ] Can `extraArgs` layer additional settings on top of project settings?
- [ ] Can hooks be injected via SDK options, or only via filesystem?
- [ ] Settings merge behavior: user-level + project-level — merge or override?
- [ ] CLAUDE.md vs AGENTS.md — how does the CLI treat each? Both loaded? Priority?

## Design Principles

- **Pull/aggregate, not push/seed.** Unlike OpenClaw which stamps identity files into workspace dirs at bootstrap, ClearClaw's workspaces are real project repos. The shared layer harvests insights back to a unified store, not the other way around. The store gets richer over time as workspaces accumulate knowledge.
- **Not necessarily MCP.** Could be any tool/plugin/extension mechanism the CLI supports. MCP is one option; user-space tools that read/write ClearClaw-managed files is another.
- **Hooks as lifecycle glue.** Tools serve knowledge on demand; hooks handle the *when* — inject identity on session start, sync memory on writes, etc. Together they cover both directions.
- **ACP compatibility.** Whatever mechanism we use needs to translate to ACP, not just Claude Code.
- **Fallback: user-space installation.** If SDK-level injection conflicts with project settings, alternative is tools installed at the user level (~/.claude/) that are ClearClaw-specific and read/write ClearClaw-managed stores.

## Design Approach: SDK-level injection at session creation

ClearClaw controls session creation. Shared layer lives in `~/.clearclaw/shared/` and gets injected via SDK options — no filesystem mods to project repos.

| Concern | Mechanism | Notes |
|---------|-----------|-------|
| Identity | System prompt / `instructions` | Short, stable (~3KB) |
| Memory (read) | Tool (MCP or other) | On-demand from unified store |
| Memory (write) | Hooks | Propagate changes back to unified store |
| Hooks | SDK extraArgs or merged config | Need to verify additive support |
| Permissions | SDK extraArgs with settings | Shared patterns layered on top |

## Unified Memory Store

Location: `~/.clearclaw/memory/`. Not a replacement for per-project memory — a complement.

```
Workspace A session → learns something → CLI writes to A's memory
                                        → hook reflects to unified store
Workspace B session → needs context    → MCP tool queries unified store
```

## Open Design Questions

1. What goes unified vs stays project-local? Boundary rules needed
2. Conflict resolution — project memory wins for project-specific things
3. Storage format — flat files? SQLite? Needs to be searchable
4. Hook injection — if SDK can't inject hooks, alternative? (wrapper? symlinks? user-space install?)
5. How does the same model translate to ACP (not just Claude Code)?
6. If settings aren't additive, can user-space tools in ~/.claude/ work as fallback?

## Research: Other Claws

### OpenClaw

**Memory:** SQLite + vector index (FTS + embeddings) of workspace files in `~/.openclaw/workspace/`. Exposes `memory_search` and `memory_get` tools at session time. Memory is per-workspace; no cross-workspace sharing. Multiple agents can share a workspace or use separate ones.

**Identity:** `IDENTITY.md` with structured fields + several bootstrap files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `USER.md`, etc.) all from one workspace directory. No per-project layering — one workspace = one identity.

**Settings:** Single `~/.openclaw/openclaw.json` (JSON5). Composable via `$include` deep-merge. Per-agent overrides in config. No user-vs-project stacking like Claude Code's `.claude/`.

**Tools:** All assembled at session start, passed as `customTools` (never `builtInTools`). Multi-layer tool policy pipeline. Plugins inject context via `before_agent_start` hooks.

**ACP:** Implements ACP as gateway bridge. `AcpRuntime` registry for backends. Embedded runner supports 10+ model providers. Bridge is partial (no per-session MCP).

**Relevance:** Workspace-as-single-source works when OpenClaw owns it. ClearClaw can't — workspaces are real project repos. The `customTools` approach gives total control but we want to layer on top, not replace.

### NanoClaw

**Memory:** File-based, relying on SDK's built-in CLAUDE.md loading. Global memory in `groups/global/CLAUDE.md`, per-group in `groups/{folder}/CLAUDE.md`. Conversation archive via `PreCompact` hook writing dated markdown. No custom indexing.

**Identity:** Stored in CLAUDE.md files. Global persona injected via `systemPrompt: { preset: 'claude_code', append: globalClaudeMd }`. No separate identity file. Duplication between global and per-group possible.

**Settings:** Container `settings.json` for SDK flags, MCP servers passed programmatically via `query()`. SDK merge order: programmatic > local > project > user.

**Tools:** Explicit `allowedTools` whitelist + one MCP server injected via `mcpServers` option. MCP provides `send_message`, `schedule_task`, etc. via filesystem IPC. Hooks registered programmatically (`PreCompact`, `PreToolUse`).

**ACP:** None. Entirely built on Claude Agent SDK with no abstraction.

**Relevance:** `systemPrompt.append` pattern is directly applicable for identity injection. Programmatic `mcpServers` and `hooks` confirm SDK-level injection works without filesystem mods.

### Key Takeaways

1. **SDK programmatic injection works.** NanoClaw proves `systemPrompt.append`, `mcpServers`, and `hooks` can all be injected via `query()` without touching project files. Validates our approach.
2. **Neither solved cross-workspace memory.** OpenClaw is per-workspace, NanoClaw is per-group with manual injection. Our "pull/aggregate" unified store would be novel.
3. **Identity:** ClearClaw should follow NanoClaw's `systemPrompt.append` — we don't own the workspace.
4. **MCP is the right tool mechanism.** Both use MCP for custom tools, injected programmatically. A single MCP server with memory tools is sufficient.
5. **Hooks are programmatic.** NanoClaw registers via SDK `hooks` option — no filesystem needed. Answers our open question.
6. **ACP is unsolved.** OpenClaw has partial bridge, NanoClaw has nothing. Can defer.
7. **Config layering: programmatic wins.** SDK merge order means our injections take priority. Inject additively where project should win.

## Next Steps

1. Verify SDK capabilities (key questions above) — partially answered by NanoClaw's patterns
2. Prototype MCP server with minimal surface (1-2 tools)
3. Test hook injection approaches
4. Design unified memory store format
