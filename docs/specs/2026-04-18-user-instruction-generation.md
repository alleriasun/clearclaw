# User Instruction Generation & Ongoing Learning

**Date:** 2026-04-18
**Status:** Design
**Depends on:** [Prompt Assembly](2026-04-17-prompt-assembly.md)

## Context

The prompt assembly architecture introduced `instructions/` (IDENTITY.md, USER.md, TOOLS.md) as user-owned files that shape agent behavior. But there's no guided flow for creating them. A new user gets an empty `instructions/` directory and has to figure out what to put there.

Additionally, the home workspace is currently created silently by `ensureDefaultWorkspace()`, bypassing any onboarding experience for DM users.

### Goals

1. Guide new users through populating their instruction files during onboarding
2. Unify DM and group onboarding through the same task session path
3. Give the agent clear guidance on continuously maintaining instruction files as it learns
4. Wire `chatType` so the onboarding flow can distinguish DMs from groups programmatically

## Design

### Unified Onboarding Flow

**Today:** All unmapped chats (DM or group) from authorized users go through a task session with the onboarding prompt. However, `approveUser()` (pairing flow) calls `ensureDefaultWorkspace()`, which silently creates the home workspace, bypassing the onboarding experience for paired users' first DM.

**New:** All unmapped chats (DM or group) follow the same path:

1. Authorized user messages from unmapped chat → task session starts
2. Onboarding prompt detects chat type (via `chatType` on the inbound message)
3. **Group chat:** Same as today — ask about the project, create workspace, `task_complete`
4. **DM:** Create home workspace, transition to bootstrap ("get to know you"), populate instruction files, `task_complete`

`ensureDefaultWorkspace()` is removed. `approveUser()` simplified to just add the user (no `chatId` param, no workspace creation). The workspace gets created through the onboarding flow when the user actually messages.

### chatType in Task Sessions

`chatType` is already populated by both channels (Telegram and Slack). No channel code changes needed.

**Orchestrator change:** When creating a task session for an unmapped chat, interpolate the first message's `chatType` into the task prompt (e.g. `"This is a DM chat."` or `"This is a group chat."`). The onboarding prompt uses this to decide whether to run the bootstrap phase.

### Bootstrap Flow (DM Onboarding)

When the onboarding task session detects a DM, it creates the home workspace and transitions to a "get to know you" bootstrap. Hybrid approach: starts structured, then opens up.

**Structured phase (hard facts):**
- What should I call you?
- What timezone?
- What personality/vibe do you want from me?
- Pick a name for me (or let me suggest one)

**Tool discovery:**
- Agent scans PATH for common CLI tools relevant to tasks users expect agents to handle (email, calendar, notes, task management, dev tools, file management)
- Presents findings: "I see you have brew, git, node. Any other tools you want me to know about?"
- Notes preferred package manager and whether user wants proactive tool installation

**Open-ended phase:**
- "Anything else I should know about you, your work, your preferences?"
- User goes wherever they want; agent follows without constraining
- If the user shares something that belongs in memory, agent captures it without interrupting flow

**Output — agent sorts into the right files:**
- Behavioral directives → `instructions/IDENTITY.md`, `USER.md`, `TOOLS.md`
- Facts, context, decisions → `memory/MEMORY.md`
- Calls `workspace_create` + `task_complete`

### Ongoing Learning (SYSTEM.md Update)

Add a "Persistence Routing" section to SYSTEM.md:

- `instructions/` — behavioral directives that shape every turn. If it changes how you act, it's an instruction.
- `memory/MEMORY.md` — curated context and decisions. Facts that might be relevant.
- `memory/YYYY-MM-DD.md` — what happened today. Raw session logs.
- `knowledge/` — topical depth. Research, articles, plans. Separate concern.

The agent should continuously update instruction files as it learns, route learnings to the right layer without asking the user, and default to: affects next turn → instruction, context for later → memory.

### Tool Selection Philosophy (SYSTEM.md)

Framework-level guidance for all agents (user can override):

- Prefer CLIs and existing tools over custom code
- Prefer well-maintained, proven tools over niche ones
- Note the user's preferred package manager
- Don't install tools without asking unless user has opted in
- Present options with tradeoffs when recommending tools

### Code Changes

| File | Change |
|------|--------|
| `src/orchestrator.ts` | Interpolate `chatType` into task session prompt |
| `src/config.ts` | Remove `ensureDefaultWorkspace()`, simplify `approveUser()` |
| `prompts/ONBOARDING.md` | Add bootstrap phase for DM chats |
| `prompts/SYSTEM.md` | Add persistence routing + tool selection philosophy |

### Future Considerations

- **`/setup` command:** Re-run bootstrap on demand. Not needed now.
- **Owner concept:** Instance assumes one primary user (first DM). If multi-owner needed, add `OWNER_ID` env var.