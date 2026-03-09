# Plan: Carry default workspace identity into all ClearClaw sessions

## Context

ClearClaw supports multiple workspaces — a default "home" workspace (personal assistant) and project workspaces. The default workspace's `CLAUDE.md` defines a rich identity (personality, user knowledge, communication style), but project workspaces never see it. This means the bot has a split personality: warm and personal at home, generic in projects.

### Research findings

**Claude Agent SDK:**
- The SDK's `systemPrompt: { type: 'preset', preset: 'claude_code', append: '...' }` keeps the full Claude Code system prompt (including all CLAUDE.md files loaded via `settingSources`) and appends extra text. `preset: 'claude_code'` is the only preset — it's also the default when `systemPrompt` is omitted.
- `settingSources: ["user", "project", "local"]` loads `~/.claude/CLAUDE.md` (user-level coding conventions) and project CLAUDE.md files independently. The `append` is additive, not conflicting.
- Using `~/.claude/CLAUDE.md` for identity was considered but rejected — that file likely already contains coding conventions, and mixing identity into it is messy. There's no way to have multiple user-level CLAUDE.md files.

**Kiro CLI comparison (ACP — Agent Client Protocol):**
- Kiro uses ACP (JSON-RPC 2.0 over stdio) as its programmatic interface (`kiro-cli acp`). The protocol's `session/new` and `session/prompt` methods do NOT expose any system prompt parameter — only `cwd`, `mcpServers`, and the user message.
- Kiro's workarounds are all filesystem-based: global steering files (`~/.kiro/steering/*.md`), custom agent configs with a `prompt` field, and `AGENTS.md` files. A Kiro-based relay would have to write identity to disk before the session starts.
- Kiro uses named canonical files for different concerns (`product.md`, `tech.md`, `structure.md`) rather than a single monolithic file per scope. Interesting for future decomposition but premature for now.
- **Validation:** Claude's SDK `systemPrompt.append` is a cleaner mechanism — programmatic injection per-call without filesystem side effects, while the preset ensures all normal CLAUDE.md loading still happens alongside.

**Why not inject via user prompt (prepending identity to each user message):**
- Wrong role — system-level instructions in the user message compete with actual user intent.
- Context waste — not cached/compressed like system prompt content.
- Prompt injection surface — user messages are lower-privilege, identity instructions there are easier to override.
- Breaks session resume — identity text baked into conversation history as user messages.

### Design decision

Instead of creating a separate `identity.md` file, we simply **append the default workspace's `CLAUDE.md` to all non-default workspace sessions**. This avoids splitting the default workspace's content into identity vs. home-specific pieces — the model is smart enough to ignore home-specific instructions (task warrior, etc.) when working in a project context. No new files, no maintenance of a separate identity layer.

For the default workspace itself, `settingSources` already loads its CLAUDE.md naturally (it's the project CLAUDE.md for that cwd), so we skip the append to avoid duplication.

This is opt-in by file presence: if the default workspace has a CLAUDE.md, identity carries everywhere. If it doesn't (pure relay mode), nothing changes.

## Changes

### 1. `src/types.ts` — add optional field to `RunTurnOpts`

Add `appendSystemPrompt?: string` to `RunTurnOpts`. The engine uses this if present, ignores if absent.

### 2. `src/engine/claude-code.ts` — use `systemPrompt.append`

When `opts.appendSystemPrompt` is provided, pass `systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: opts.appendSystemPrompt }` in the `query()` options. When absent, omit `systemPrompt` entirely (today's behavior — defaults to the preset).

### 3. `src/orchestrator.ts` — read identity, thread to engine

- Add `defaultWorkspaceDir: string` to `OrchestratorOpts`
- On each turn for a **non-default** workspace: read `{defaultWorkspaceDir}/CLAUDE.md` (if it exists), pass as `appendSystemPrompt` to `engine.runTurn()`
- On each turn for the **default** workspace: don't pass `appendSystemPrompt` (settingSources handles it)
- Read per-turn (not cached) so edits to the identity file take effect without restarting ClearClaw
- If the file doesn't exist or is empty, silently skip — pure relay behavior

### 4. `src/index.ts` — wire up the path

Pass `defaultWorkspaceDir: path.join(config.dataDir, "workspace")` to the `Orchestrator` constructor.

## Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `appendSystemPrompt?: string` to `RunTurnOpts` |
| `src/engine/claude-code.ts` | Conditionally set `systemPrompt` in `query()` options |
| `src/orchestrator.ts` | Add `defaultWorkspaceDir` opt, read CLAUDE.md per-turn, pass to engine |
| `src/index.ts` | Pass `defaultWorkspaceDir` to orchestrator |

## Verification

1. `npm run check` — type check passes
2. `npm run build` — builds cleanly
3. Manual test: send a message in a project workspace group, verify the identity/personality carries through in the response
4. Manual test: send a message in the default workspace DM, verify no duplication (behavior unchanged)
5. Manual test: delete/empty the default workspace's CLAUDE.md, verify project workspaces still work (pure relay, no append)

## Post-implementation

Update `docs/ARCHITECTURE.md` to document:
- Identity injection: how the default workspace's CLAUDE.md is appended to all non-default workspace sessions via `systemPrompt.append`
- The system prompt layering: Claude Code preset → `~/.claude/CLAUDE.md` (user) → project CLAUDE.md (settingSources) → default workspace CLAUDE.md (append)
- Opt-in behavior: file presence drives PA vs relay mode
- Design rationale: why `systemPrompt.append` over `~/.claude/CLAUDE.md` or user prompt injection
