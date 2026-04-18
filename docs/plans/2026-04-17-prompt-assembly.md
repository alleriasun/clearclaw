# Prompt Assembly Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the monolithic home workspace CLAUDE.md with a prompt assembler that concatenates framework files (bundled in repo) and user instruction files (in workspace) into a single system prompt per turn.

**Architecture:** New `src/prompt.ts` module with `assemblePrompt()` reads markdown files from two directories — `prompts/` (framework, bundled) and `~/.clearclaw/workspace/instructions/` (user-owned) — and concatenates them. Orchestrator calls this instead of `readDefaultPrompt()`. Skills infrastructure (`syncSkills()`, `skills/`) removed; onboarding skill becomes a prompt file.

**Tech Stack:** TypeScript, Node.js fs, existing ClearClaw architecture

**Spec:** `docs/specs/2026-04-17-prompt-assembly.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/prompt.ts` | `assemblePrompt()` function — reads and concatenates framework + user markdown files |
| Create | `prompts/SYSTEM.md` | Framework behavior: session startup, memory system, knowledge base, safety, privacy, workspace layout, platform formatting, self-evolution |
| Create | `prompts/ONBOARDING.md` | Workspace onboarding flow (moved from `skills/onboarding/SKILL.md`) |
| Modify | `src/orchestrator.ts` | Replace `readDefaultPrompt()` with `assemblePrompt()`, remove home workspace skip logic |
| Modify | `src/config.ts` | Add `instructionsDir` and `frameworkPromptDir` paths, remove `syncSkills()`, update `ensureDefaultWorkspace()` |
| Modify | `package.json` | Add `prompts/` to `files` array for npm packaging |
| Delete | `skills/onboarding/SKILL.md` | Moved to `prompts/ONBOARDING.md` |
| Runtime | `~/.clearclaw/workspace/instructions/IDENTITY.md` | User: agent personality (decomposed from CLAUDE.md) |
| Runtime | `~/.clearclaw/workspace/instructions/USER.md` | User: profile + communication style (moved from workspace root) |
| Runtime | `~/.clearclaw/workspace/instructions/TOOLS.md` | User: CLI tools on this machine (decomposed from CLAUDE.md) |

---

## Chunk 1: Assembler Module + Framework Prompt Files

### Task 1: Create `src/prompt.ts`

**Files:**
- Create: `src/prompt.ts`

- [ ] **Step 1: Create the assemblePrompt function**

```typescript
import fs from "node:fs";
import path from "node:path";

/**
 * Read all .md files from a directory, sorted alphabetically.
 * Returns empty array if directory doesn't exist.
 */
function readMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), "utf-8").trim())
    .filter(Boolean);
}

/**
 * Assemble the system prompt from framework and user instruction files.
 * Framework content comes first, user content appended after.
 * Returns undefined if no content found in either directory.
 */
export function assemblePrompt(
  frameworkDir: string,
  instructionsDir: string,
): string | undefined {
  const framework = readMarkdownFiles(frameworkDir);
  const user = readMarkdownFiles(instructionsDir);

  if (framework.length === 0 && user.length === 0) return undefined;

  const parts: string[] = [];

  if (framework.length > 0) {
    parts.push("# ClearClaw System Instructions\n");
    parts.push(framework.join("\n\n---\n\n"));
  }

  if (user.length > 0) {
    parts.push("# User Instructions\n");
    parts.push(user.join("\n\n---\n\n"));
  }

  return parts.join("\n\n");
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run check`
Expected: No errors related to `src/prompt.ts`

- [ ] **Step 3: Commit**

```bash
git add src/prompt.ts
git commit -m "feat: add prompt assembler module"
```

### Task 2: Create `prompts/SYSTEM.md`

**Files:**
- Create: `prompts/SYSTEM.md`
- Reference: `~/.clearclaw/workspace/CLAUDE.md` (source content to decompose)

Extract framework sections from the current home workspace CLAUDE.md. These are the sections that are NOT user-specific — they define how the agent operates regardless of who's using it.

- [ ] **Step 1: Create `prompts/SYSTEM.md` with framework content**

Extract and adapt these sections from `~/.clearclaw/workspace/CLAUDE.md`:
- "Every Session" → `## Session Startup`
- "Memory System" → `## Memory System`
- "Knowledge Base" → `## Knowledge Base`
- "Safety & Boundaries" → `## Safety`
- "Privacy & Discretion" → `## Privacy`
- "Workspace Layout" → `## Workspace Layout` (update layout to show `instructions/` directory)
- "Formatting" (platform constraints only, e.g. Telegram table limitations) → `## Platform Formatting`
- "Make It Mine" → `## Self-Evolution`

Remove all user-specific content: Paddy's name, Yelia's personality, specific tool references (gws, zk, task), timezone, etc. Keep only generic framework behavior that applies to any ClearClaw user.

- [ ] **Step 2: Verify the file is self-contained and has no user-specific references**

Read through and confirm no references to specific users, agent names, or machine-specific tools.

- [ ] **Step 3: Commit**

```bash
git add prompts/SYSTEM.md
git commit -m "feat: add framework system prompt"
```

### Task 3: Create `prompts/ONBOARDING.md`

**Files:**
- Create: `prompts/ONBOARDING.md`
- Reference: `skills/onboarding/SKILL.md` (source)

- [ ] **Step 1: Move skill content to prompt file**

Copy `skills/onboarding/SKILL.md` to `prompts/ONBOARDING.md`. Remove the YAML frontmatter (`---` block with name/description/user-invocable). Keep the markdown content as-is — it's already well-written framework content.

- [ ] **Step 2: Commit**

```bash
git add prompts/ONBOARDING.md
git commit -m "feat: move onboarding skill to prompt file"
```

---

## Chunk 2: Config Changes

### Task 4: Update `src/config.ts`

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add path properties**

Add after `logPath` declaration (line 85):

```typescript
readonly instructionsDir: string;
readonly frameworkPromptDir: string;
```

In constructor, after `this.logPath = ...` (line 94):

```typescript
this.instructionsDir = path.join(this.dataDir, "workspace", "instructions");
this.frameworkPromptDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "prompts",
);
```

- [ ] **Step 2: Remove `syncSkills()` method** (lines 293-300)

- [ ] **Step 3: Update `ensureDefaultWorkspace()`** — remove `this.syncSkills()` call (line 290) and add `instructions/` directory creation:

```typescript
fs.mkdirSync(path.join(defaultCwd, "instructions"), { recursive: true });
```

- [ ] **Step 4: Verify** — `npm run check` — no errors

- [ ] **Step 5: Commit**

```bash
git add src/config.ts
git commit -m "feat: add prompt dir paths, remove syncSkills"
```

---

## Chunk 3: Orchestrator Integration

### Task 5: Update `src/orchestrator.ts`

**Files:**
- Modify: `src/orchestrator.ts`

- [ ] **Step 1: Add import**

```typescript
import { assemblePrompt } from "./prompt.js";
```

- [ ] **Step 2: Replace `appendSystemPrompt` logic in `executeTurn()`**

Replace lines 197-200:

```typescript
// OLD:
const isHomeWorkspace = ws && ws.cwd === path.dirname(this.config.defaultPromptPath);
const appendSystemPrompt = task
  ? task.prompt
  : (isHomeWorkspace ? undefined : this.readDefaultPrompt());
```

With:

```typescript
// NEW:
const assembledPrompt = assemblePrompt(
  this.config.frameworkPromptDir,
  this.config.instructionsDir,
);
const appendSystemPrompt = task
  ? (assembledPrompt ? `${task.prompt}\n\n${assembledPrompt}` : task.prompt)
  : assembledPrompt;
```

Note: task sessions now get their task prompt + assembled prompt (including ONBOARDING.md). This is intentional — the onboarding flow needs ONBOARDING.md in context to work. Previously the onboarding skill was loaded from `.claude/skills/` by the SDK; now it's part of the assembled system prompt.

- [ ] **Step 3: Delete `readDefaultPrompt()` method** (lines 696-704)

- [ ] **Step 4: Update task session prompt text** (lines 432-435)

Change `"Your only job: help set up a workspace for this chat. Use the onboarding skill."` to `"Your only job: help set up a workspace for this chat. Follow the Workspace Onboarding instructions in the system prompt."`

- [ ] **Step 5: Clean up unused imports** — check if `fs` and `path` are still needed after removing `readDefaultPrompt()` and `isHomeWorkspace`

- [ ] **Step 6: Verify** — `npm run check` — no errors

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: use prompt assembler, remove readDefaultPrompt"
```

---

## Chunk 4: Cleanup + Packaging

### Task 6: Delete `skills/` directory

**Files:**
- Delete: `skills/onboarding/SKILL.md`
- Delete: `skills/onboarding/` (directory)
- Delete: `skills/` (directory)

- [ ] **Step 1: Remove skills directory**

```bash
rm -rf skills/
```

- [ ] **Step 2: Commit**

```bash
git add -A skills/
git commit -m "chore: remove skills dir (moved to prompts/)"
```

### Task 7: Update `package.json`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `prompts/` to the `files` array**

The `files` array (line 28) currently only includes `dist/`. Add `prompts/` so framework prompt files are included in npm packages:

```json
"files": [
  "dist/**/*.js",
  "dist/**/*.d.ts",
  "prompts/**/*.md"
],
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "chore: include prompts/ in npm package"
```

---

## Chunk 5: User Content Migration

This chunk creates the user instruction files by decomposing content from the current `~/.clearclaw/workspace/CLAUDE.md`. This is a runtime migration — these files live on Paddy's machine, not in the repo.

### Task 8: Create user instruction files

**Files:**
- Create: `~/.clearclaw/workspace/instructions/IDENTITY.md`
- Create: `~/.clearclaw/workspace/instructions/USER.md`
- Create: `~/.clearclaw/workspace/instructions/TOOLS.md`

- [ ] **Step 1: Create `instructions/` directory**

```bash
mkdir -p ~/.clearclaw/workspace/instructions
```

- [ ] **Step 2: Create `IDENTITY.md`**

Extract from current CLAUDE.md: "Who I Am" section (Yelia personality, core truths, vibe). This is everything about the agent's identity and behavioral style.

- [ ] **Step 3: Create `USER.md`**

Extract from current CLAUDE.md: "Who I'm Helping" section (Paddy's profile, relationship, work/interests, struggles). Add a `## Communication Style` section with relevant style preferences from the "Formatting" section (user preferences only, not platform constraints).

Move existing `~/.clearclaw/workspace/USER.md` content here if it has additional content not in CLAUDE.md.

- [ ] **Step 4: Create `TOOLS.md`**

Extract from current CLAUDE.md: "Tools & CLI" section (tool table, tool notes, email protocol, skill loading, philosophy). Everything about what tools are available on this machine and how to use them.

- [ ] **Step 5: Delete old CLAUDE.md**

```bash
rm ~/.clearclaw/workspace/CLAUDE.md
```

**Critical:** This must happen or the SDK will load it via `settingSources` (it's in the home workspace `cwd`), duplicating content with the assembled prompt.

Also remove the old USER.md from workspace root if its content has been merged into `instructions/USER.md`:

```bash
rm ~/.clearclaw/workspace/USER.md
```

- [ ] **Step 6: Verify** — Start ClearClaw (`npm run dev`), send a test message, confirm the agent sees both framework and user instructions in its context.

---

## Chunk 6: Docs Update

### Task 9: Update `docs/ARCHITECTURE.md`

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Replace "Default Prompt Append" section** (lines 124-152)

Replace with a "Prompt Assembly" section describing:
- Two source directories: `prompts/` (framework) and `workspace/instructions/` (user)
- `assemblePrompt()` reads both per-turn
- Output passed via `systemPrompt.append`
- The effective 4-layer stack

- [ ] **Step 2: Update "File Structure"** (lines 42-55)

Add `prompt.ts` to the file listing. Remove reference to skills if present.

- [ ] **Step 3: Update "Storage"** (lines 229-235)

Update `~/.clearclaw/workspace/` description to mention `instructions/` directory instead of `CLAUDE.md`.

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: update architecture for prompt assembly"
```

### Task 10: Update `docs/TASKS.md`

**Files:**
- Modify: `docs/TASKS.md`

- [ ] **Step 1: Mark the prompt assembly task as complete**

Change `- [ ] Prompt assembly architecture — ...` to `- [x] Prompt assembly architecture — ...`

- [ ] **Step 2: Commit**

```bash
git add docs/TASKS.md
git commit -m "docs: mark prompt assembly complete"
```

---

## Follow-up (not in scope)

- **Rename `config.defaultPromptPath`** — after this change it's only used for `path.dirname()` to identify the home workspace directory (in `effectiveBehavior`). The name is misleading since it no longer points to a prompt file. Consider renaming to `homeWorkspaceCwd` or adding a dedicated property. Low priority — it works correctly as-is.