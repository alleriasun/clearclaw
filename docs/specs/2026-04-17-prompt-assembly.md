# Prompt Assembly Architecture

**Date:** 2026-04-17
**Status:** Design

## Context

The home workspace `CLAUDE.md` (~265 lines) is a monolith that mixes framework behavior (memory system, session routine, safety boundaries) with user customization (personality, profile, tool inventory). This causes three problems:

1. **Framework updates clobber user edits.** Improving the memory system means editing the same file where the user defined their agent's personality.
2. **User edits require navigating framework content.** Changing the agent's voice means scrolling past session routines and knowledge base conventions.
3. **Not engine-agnostic.** The current mechanism (read one file, pass as `systemPrompt.append`) is a Claude Code SDK detail. A second engine would need to be handled differently, but the prompt sources are the same regardless of engine.

### What we explored

Three assembly approaches were considered:

1. **Assembler in the orchestrator** — minimal new code, but tangles assembly with orchestration. Hard to extend for multi-engine.
2. **Standalone PromptAssembler module** — clean separation, testable, engine-agnostic. **Selected.**
3. **Assembly as an engine concern** — each engine formats for itself, but duplicates logic that's identical across engines.

Approach 2 was selected: assembly is a distinct concern from orchestration and from engine-specific delivery.

### Landscape survey

| Project | Owns assembly? | Framework content | User content | Mechanism |
|---------|---------------|------------------|-------------|-----------|
| **OpenClaw** | Yes, fully | Hardcoded in TypeScript (`system-prompt.ts`, 971 lines) | Named workspace files: `IDENTITY.md`, `SOUL.md`, `USER.md`, `TOOLS.md` | Procedural build + concatenation with cache boundary |
| **NanoClaw** | Partially | Bundled templates, copied to disk per group | Per-group `CLAUDE.md` | SDK preset + append |
| **ClearClaw** (today) | Partially | Home workspace `CLAUDE.md` | Mixed in same file | SDK preset + append |
| **RemoteCode** | No | None (pure SDK passthrough) | None | SDK handles everything |
| **ClaudeCodeUI** | No | None | SDK-discovered `CLAUDE.md` files | `settingSources` only |

OpenClaw is the most relevant prior art — it owns assembly with a framework/user split. Our design is similar but simpler: markdown files in the package instead of hardcoded TypeScript, flat concatenation instead of cache boundaries. OpenClaw's named-file conventions informed our user source naming.

OpenClaw file roles: `AGENTS.md` is their dev-facing project CLAUDE.md (coding standards, build commands), not user-facing. `SOUL.md` is agent persona/values. `BOOTSTRAP.md` is a one-time first-run wizard that creates identity files then self-deletes — equivalent to ClearClaw's onboarding skill.

## Design

### Source Model

Two source categories, each a directory of markdown files:

**Framework sources** — bundled in the ClearClaw package at `prompts/`:

| File | Content |
|------|---------|
| `SYSTEM.md` | All core framework behavior: session startup routine, memory system architecture, knowledge base conventions, safety boundaries, privacy rules, workspace layout, platform formatting constraints, self-evolution |
| `ONBOARDING.md` | Workspace onboarding flow (replaces the skill previously synced to `.claude/skills/`) |

One `SYSTEM.md` for all framework behavior — no natural split exists since it's all one author (ClearClaw), one edit trigger (release), one audience (the agent). `ONBOARDING.md` is separate because it's a procedural guide for a specific event, not general behavior.

These ship with ClearClaw and update with releases. Users don't edit them. The assembler reads all `.md` files from the directory, so adding files doesn't require code changes.

**User sources** — live in the home workspace at `~/.clearclaw/workspace/instructions/`:

| File | Content |
|------|---------|
| `IDENTITY.md` | Agent personality, voice, vibe, core truths (who the agent is) |
| `USER.md` | User profile, preferences, timezone, communication style (who the human is) |
| `TOOLS.md` | CLI tools available on this machine, configurations (what's on the machine) |

Three files with a natural split: agent vs human vs machine. Each has different edit triggers — personality tweaks vs life changes vs tool installs.

All optional. If none exist, the agent gets framework behavior only. The assembler reads all `.md` files from the directory, so users can add files without code changes.

**Unchanged:** Project `CLAUDE.md` files in each workspace's `cwd` (loaded by SDK via `settingSources`).

**Removed:** `syncSkills()` and `.claude/skills/` for framework content. The onboarding skill moves into `prompts/ONBOARDING.md` and gets assembled into the system prompt. User-authored skills or dynamic skill loading is a future concern.

### Assembly Mechanism

A new `src/prompt.ts` module:

```typescript
function assemblePrompt(frameworkDir: string, userDir: string): string | undefined
```

1. Read all `.md` files from `frameworkDir` (bundled `prompts/`)
2. Read all `.md` files from `userDir` (`~/.clearclaw/workspace/instructions/`)
3. Concatenate: framework content first, then user content, with section headers and `---` separators
4. Return the assembled string, or `undefined` if both directories are empty/missing

**Ordering:** Alphabetical by filename within each category. UPPERCASE naming makes this predictable. Numeric prefix convention (e.g. `01-SESSION.md`) available if finer control is ever needed.

**Output shape:**

```
# ClearClaw System Instructions

<framework files, concatenated with --- separators>

# User Instructions

<user files, concatenated with --- separators>
```

**Assembly timing:** Per-turn. Files read fresh every time. Edits take effect on the next message without restart.

### Integration

**Today:** Orchestrator calls `readDefaultPrompt()` → reads home `CLAUDE.md` → passes as `appendSystemPrompt`. Home workspace skipped to avoid duplication.

**New:** Orchestrator calls `assemblePrompt(frameworkDir, userDir)` → passes result as `appendSystemPrompt`. No skip logic — every workspace gets the assembled prompt.

**What changes:** `readDefaultPrompt()` removed, "skip for home workspace" check removed.

**What doesn't change:** `RunTurnOpts.appendSystemPrompt` (same string), `ClaudeCodeEngine.runTurn()` (untouched), `settingSources` (still loads project CLAUDE.md from cwd), Engine interface (no new fields).

**Effective prompt layering:**
1. Claude Code preset (base system prompt)
2. `~/.claude/CLAUDE.md` — user-level coding conventions (SDK `settingSources`)
3. `{cwd}/CLAUDE.md` — project-specific instructions (SDK `settingSources`)
4. Assembled prompt — framework + user content (via `systemPrompt.append`)

### Migration

Current `~/.clearclaw/workspace/CLAUDE.md` decomposed:

**→ Framework (`prompts/SYSTEM.md`)** — one file with clear `##` sections:

| Current section | SYSTEM.md section |
|---|---|
| "Every Session" routine | `## Session Startup` |
| "Memory System" | `## Memory System` |
| "Knowledge Base" | `## Knowledge Base` |
| "Safety & Boundaries" | `## Safety` |
| "Privacy & Discretion" | `## Privacy` |
| "Workspace Layout" | `## Workspace Layout` |
| "Formatting" (platform constraints) | `## Platform Formatting` |
| "Make It Mine" (self-evolution) | `## Self-Evolution` |

**→ Framework (`prompts/ONBOARDING.md`):**
- `skills/onboarding/SKILL.md` → moves here as a prompt file

**→ User (`~/.clearclaw/workspace/instructions/`):**

| Current section | New file |
|---|---|
| "Who I Am" (Yelia personality, core truths, vibe) | `IDENTITY.md` |
| "Who I'm Helping" + communication style | `USER.md` |
| "Tools & CLI", "Email Protocol", "Skill Loading" | `TOOLS.md` |

**→ Deleted:**
- `~/.clearclaw/workspace/CLAUDE.md` — must be manually deleted after decomposing content into `instructions/`. If left in place, the SDK loads it via `settingSources` (it's in the home workspace `cwd`), duplicating content with the assembled prompt.
- `readDefaultPrompt()` — replaced by `assemblePrompt()`
- "Skip for home workspace" logic — all workspaces get the assembled prompt
- `syncSkills()` — framework skills become prompt files. `ensureDefaultWorkspace()` calls `syncSkills()` and must be updated.
- `skills/` directory in repo — content moves to `prompts/ONBOARDING.md`
- Task session prompt text — currently references "the onboarding skill". Must be updated to reference the onboarding instructions in the system prompt.

**Note on scope:** The assembled prompt (including `ONBOARDING.md`) is appended to every workspace — home and project alike. Project workspaces see onboarding instructions they didn't previously receive. This is intentional: the token overhead is small (~50 lines), and a clear section header lets the model ignore it when irrelevant.

### File Layout

**New in repo:**

```
prompts/               # Framework prompt sources (read at assembly time)
  SYSTEM.md            # Core framework behavior (all sections)
  ONBOARDING.md        # Workspace onboarding flow

src/
  prompt.ts            # assemblePrompt() function
```

`prompts/` at repo root (replacing `skills/`). Read from package root via `import.meta.url`, same pattern `syncSkills()` uses today. Not inside `src/`, not processed by `tsc`.

**New at runtime:**

```
~/.clearclaw/workspace/
  instructions/          # User-owned prompt sources
    IDENTITY.md          # About the agent
    USER.md              # About the human
    TOOLS.md             # About the machine
```

**Config:** `instructionsDir` path added (`workspace/instructions/`). `frameworkPromptDir` resolved from package root.

### Future Considerations

- **Dynamic skill loading:** If more framework skills are added and prompt size becomes a concern, build on-demand loading instead of always-in-context assembly. Not needed for two files.
- **User onboarding skill:** A first-run flow guiding new users through creating IDENTITY.md, USER.md, TOOLS.md. Extends the existing onboarding task session pattern.
- **Cache boundary:** Splitting assembled content into cache-stable (framework) and volatile (user) regions for prompt caching. OpenClaw does this. Premature at current scale.