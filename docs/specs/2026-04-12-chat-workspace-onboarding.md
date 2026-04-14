# Chat-Based Workspace Onboarding

**Date:** 2026-04-12
**Status:** Design
**Depends on:** [Onboarding](2026-03-19-onboarding.md), [Workspace Modes](2026-03-29-workspace-modes.md), [MCP Server](2026-03-28-mcp-server.md)

## Context

When an authorized user messages from a chat that has no linked workspace, ClearClaw responds with "No workspace linked to this chat." — a dead end. The user must manually create a workspace entry in config, set up a directory, and potentially create a git worktree. This is friction that the bot should handle.

The [onboarding spec](2026-03-19-onboarding.md) anticipated this: runtime workspace provisioning was deferred to a "model-driven conversation" follow-up. This spec delivers that follow-up.

### What we explored

Three primitives emerged during design:

1. **Task sessions** — ephemeral, scoped model conversations not tied to a workspace's `current_session_id`. Needed so the onboarding conversation doesn't pollute any workspace session.
2. **Skill/workflow abstraction** — a markdown file that defines the onboarding steps for the model to follow conversationally.
3. **Proactive prompts** — bot-initiated turns triggered by events (bot added to group) rather than user messages.

Proactive prompts are deferred — for now, the user initiates by messaging in the new chat. Task sessions and the onboarding skill are the scope of this spec.

### How other *Claws handle it

**NanoClaw** uses an MCP tool (`mcp__nanoclaw__register_group`) called by the agent inside the main group's session. Only one group's agent can register new groups.

**OpenClaw** has no runtime workspace creation — groups are added via CLI only (`openclaw workspace add`).

ClearClaw's approach: the model guides workspace creation conversationally, using MCP tools to perform the actual setup. No CLI step required after initial setup.

## Design

### Concepts

**Workspace** is the persistent, user-oriented abstraction of a chat. It maps a chat to a project directory, an engine session, and a behavior mode. It lives in `config.json` and survives restarts.

**Task** is an ephemeral process that runs in a chat. It has its own engine session and working directory, independent of any workspace. A task might create a workspace (onboarding), or just do something and finish (future: briefing). Tasks are the verb; workspaces are the noun.

**Task state is separate from chat state.** Tasks live in their own `Map<string, TaskState>` on the orchestrator, not as a field on `ChatState`. ChatState holds chat-level concerns (busy, queue, UI handles). Tasks are a routing concern with their own lifecycle.

### Task Sessions

```typescript
// On Orchestrator — separate from this.chats
private tasks = new Map<string, TaskState>();  // chatId → task

interface TaskState {
  sessionId: string | null;  // null on first turn, populated after engine "done" event
  cwd: string;               // working directory for the task
  prompt: string;            // nudge appended to system prompt
}
```

#### Routing

Task takes priority over workspace. The routing chain in `routeMessage`:

```
message arrives
  → /cancel → if task: delete task + abort. else: existing cancel behavior.
  → task exists for this chat? → route to task session (all messages, including slash commands)
  → slash commands (/mode, /new, /resume, /behavior)
  → workspace exists? → route to workspace session
  → authorized user, no workspace? → create task, route to it
  → unauthorized → existing "No workspace linked" response
```

Only `/cancel` is handled specially during a task. Everything else — including `/new`, `/mode`, `/behavior` — goes to the model. The model can respond naturally ("let's finish setup first") rather than the orchestrator needing to bucket commands.

#### Execution

Task turns use the same `engine.runTurn()` path as workspace turns, with task-specific parameters:

- `sessionId`: `task.sessionId` (null for first turn)
- `cwd`: `task.cwd` (home workspace: `~/.clearclaw/workspace/`)
- `permissionMode`: `"bypassPermissions"` — tasks run with elevated trust
- `appendSystemPrompt`: `task.prompt` — a short nudge (e.g. "You're setting up a new workspace for this chat. Use the onboarding skill.")
- `mcpServers`: ClearClaw MCP server with `workspace_create` and `task_complete` tools

The task cwd is the home workspace directory. Since the SDK uses `settingSources: ["user", "project", "local"]`, it auto-discovers the onboarding skill from `.claude/skills/onboarding/SKILL.md` in that directory. The model invokes the skill natively — no custom loading needed.

On `done` event: the returned `sessionId` is stored back into `task.sessionId` for the next turn.

#### Task lifecycle

- **Created:** Orchestrator detects unmapped chat + authorized user → inserts into `tasks` Map
- **Continues:** Subsequent messages resume the task session via stored `sessionId`
- **Completes:** Model calls `task_complete` → orchestrator deletes the task from the Map. Next message routes normally.
- **Cancelled:** `/cancel` deletes the task and aborts any running turn. One action, done.
- **No persistence.** Tasks are in-memory. Process restart = task gone. User sends another message → onboarding starts fresh.

#### Future extensibility

The task primitive is generic. Today only used for onboarding. In the future: triggered tasks (scheduled, event-driven), different lifecycle rules, possibly task persistence. None built now — the `tasks` Map is the seed.

### MCP Tools

Two new tools on ClearClaw's MCP server.

#### `workspace_create`

Creates a workspace entry in config and links it to the current chat. Pure workspace operation — no task awareness.

```typescript
tool("workspace_create", "Create a new workspace and link it to the current chat", {
  name: z.string().describe("Workspace name (unique, e.g. 'myproject')"),
  cwd: z.string().describe("Absolute path to the workspace directory"),
  behavior: z.enum(["assistant", "relay"]).optional()
    .describe("Workspace behavior (default: relay for project dirs, assistant for home)"),
})
```

- Validates `name` is unique, `cwd` exists (or creates it)
- Calls `config.upsertWorkspace({ name, cwd, chat_id: chatId, current_session_id: null, behavior })`
- Returns success message with workspace details
- **Validation failures** (duplicate name, uncreatable path) return an error string to the model, which can retry or ask the user for a different input
- `chatId` comes from orchestrator context (closure), not model input

#### `task_complete`

Signals that the current task is done. Deletes the task from the `tasks` Map. Generic — works for any task type.

```typescript
tool("task_complete", "Signal that the current task is complete", {
  message: z.string().optional().describe("Summary of what was accomplished"),
})
```

- Deletes the task entry for this chat from `this.tasks`
- Returns confirmation
- Available during task turns only
- If no task is active, returns an error

The model calls `workspace_create` (pure), then `task_complete` (generic). The two tools are fully decoupled.

Discovery (finding repos) and worktree creation are not custom MCP tools — the model runs with `bypassPermissions` and has full access to `ls`, `find`, `git worktree add` etc. through the CLI's built-in tools. The onboarding skill instructs the model to use these.

### Onboarding Skill

A native Claude Code skill at `~/.clearclaw/workspace/.claude/skills/onboarding/SKILL.md`. Auto-discovered by the SDK because the task runs with `cwd: ~/.clearclaw/workspace/` and `settingSources: ["user", "project", "local"]`.

#### Format

Standard SKILL.md with YAML frontmatter:

```yaml
---
name: onboarding
description: Set up a new workspace for a chat. Use when the system tells you a chat needs workspace setup.
user-invocable: false
---
```

`user-invocable: false` — the model auto-invokes based on the description + the orchestrator's nudge in `appendSystemPrompt`. The user doesn't call `/onboarding` directly.

#### Skill content

The markdown body instructs the model on how to guide workspace setup conversationally:

- **Context:** You're helping set up a new workspace for this chat. The user is already authorized.
- **What to learn:** What project or repo does the user want to work on? Where is it on disk?
- **Discovery:** Look for git repos in common locations (`~/`, `~/projects/`, `~/src/`, `~/repos/`). Offer what you find.
- **Worktree option:** If the user picks a git repo, offer to create a worktree (`git worktree add`). Explain the benefit (isolated branch, doesn't disturb main working tree). If they decline, use the repo path directly.
- **Workspace creation:** Once you have a name and path, call `workspace_create` (ClearClaw MCP tool). Keep the name short and descriptive.
- **Behavior:** For project repos, default to relay. For general-purpose / assistant chats, suggest assistant mode.
- **Tone:** Conversational, not interrogative. Don't dump all questions at once — guide naturally.

The skill is intentionally loose — it gives the model the goal, the model figures out the conversation.

#### Coexistence with CLAUDE.md

The home workspace already has a CLAUDE.md (identity, personality). Since the task runs with `cwd` pointing to the home workspace, the SDK picks up CLAUDE.md automatically. The model sees its identity instructions + the onboarding skill metadata. When it invokes the skill, the full SKILL.md body loads into the conversation. Both coexist naturally — CLAUDE.md is who you are, the skill is what you're doing.

### Orchestrator Changes

#### routeMessage

The current dead-end path:

```typescript
if (!ws) {
  await this.channel.sendMessage(msg.chatId, "No workspace linked to this chat.");
  return;
}
```

Becomes:

```typescript
const task = this.tasks.get(msg.chatId);
if (task) {
  this.enqueueTaskMessage(msg, task, state);
  return;
}

if (!ws) {
  if (this.config.isAuthorized(msg.user.id)) {
    const newTask: TaskState = {
      sessionId: null,
      cwd: path.dirname(this.config.defaultPromptPath),
      prompt: "You're setting up a new workspace for this chat. Use the onboarding skill to guide the user through setup.",
    };
    this.tasks.set(msg.chatId, newTask);
    this.enqueueTaskMessage(msg, newTask, state);
  } else {
    await this.channel.sendMessage(msg.chatId, "No workspace linked to this chat.");
  }
  return;
}
```

#### Task turn execution

`enqueueTaskMessage` and `executeTaskTurn` mirror the existing workspace flow but use task fields:

- Same message queueing (immediate drain, no debounce — tasks are interactive)
- Same engine event routing (text, tool_use, done, error)
- On `done`: store `sessionId` into `task.sessionId` (not into a workspace)
- ClearClaw MCP tools include `workspace_create` and `task_complete`

#### /cancel during task

`/cancel` deletes the task from `this.tasks` and aborts any running turn. One cancel = task gone, send "Setup cancelled." This is the only command the orchestrator intercepts during a task — everything else goes to the model.

### What This Doesn't Cover

- **Proactive prompts** — Bot-initiated turns (bot added to group → auto-greet). Deferred. User must send a message first.
- **Triggered tasks** — Scheduled or event-driven tasks. The `state.task` primitive supports this, but no triggers are built.
- **Task coexistence with workspaces** — Running a task in a chat that already has a workspace (e.g. morning briefing). Deferred.
- **Telegram group migration** — Supergroup ID change during onboarding. Known gotcha from the onboarding spec, not addressed here.
- **Multiple concurrent tasks** — One task per chat, always.

## Key Design Decisions

**Why task sessions instead of a state machine?** A state machine hard-codes the conversation flow — each step is a predefined prompt with expected responses. The model handles varied inputs, follow-up questions, and unexpected paths naturally. The skill gives it the goal; the model figures out how to get there.

**Why native Claude Code skills?** ClearClaw already uses the SDK with `settingSources` that enable skill discovery. Using native SKILL.md format means: standard format, auto-discovery, progressive loading (metadata always, full content on invoke), no custom loading code. The skill is a file in the home workspace, not a build artifact.

**Why `bypassPermissions` for tasks?** Tasks run in the home workspace, which already uses assistant mode with `bypassPermissions`. The model has access to built-in CLI tools (Bash, Read, Write, etc.) for discovery and worktree creation, plus the `workspace_create` MCP tool.

**Why separate `workspace_create` and `task_complete`?** `workspace_create` is a pure workspace operation — it doesn't know tasks exist. `task_complete` is a generic task lifecycle tool — it doesn't know workspaces exist. The model sequences them because it understands the goal. This keeps tools decoupled and makes both reusable independently.

**Why immediate drain (no debounce) for task turns?** Tasks are interactive conversations — the user sends a message, the model responds. This matches relay behavior. Debouncing (assistant mode) would add latency to what should feel like a direct conversation.

**Why is task state separate from ChatState?** Workspace is the persistent noun (what a chat IS). Task is the ephemeral verb (what's happening right now). They have different lifecycles, different persistence, and different ownership. Mixing task state into ChatState would conflate routing concerns with chat-level UI state. The `tasks` Map keeps them cleanly separate.

**Why duplicate task fields rather than share with Workspace?** Task and workspace params overlap (sessionId, cwd) but serve different purposes with different lifecycles. Premature unification adds abstraction without value. If patterns converge later, we unify then.
