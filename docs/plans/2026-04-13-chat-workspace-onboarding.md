# Chat-Based Workspace Onboarding — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "No workspace linked" dead end with a model-driven conversational flow that guides authorized users through workspace creation.

**Architecture:** Add a `tasks` Map to the orchestrator for ephemeral task sessions. Two new MCP tools (`workspace_create`, `task_complete`) let the model create workspaces and signal task completion. A native Claude Code SKILL.md file guides the onboarding conversation. Routing is updated to check tasks before workspaces.

**Tech Stack:** TypeScript, Claude Agent SDK (`query`, `createSdkMcpServer`), Zod, native Claude Code skills (SKILL.md)

**Spec:** `docs/specs/2026-04-12-chat-workspace-onboarding.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/orchestrator.ts` | Modify | Add `tasks` Map, `TaskState` interface, routing changes, task turn execution, `/cancel` task handling |
| `src/types.ts` | No change | Existing types sufficient |
| `src/config.ts` | No change | `upsertWorkspace` and `workspaceByName` already exist |
| `~/.clearclaw/workspace/.claude/skills/onboarding/SKILL.md` | Create (runtime) | Onboarding skill — instructions for the model |

All changes are in `src/orchestrator.ts` plus one runtime skill file. No new source files needed.

---

## Chunk 1: TaskState and MCP Tools

### Task 1: Add TaskState interface and tasks Map

**Files:**
- Modify: `src/orchestrator.ts:27-39` (after ChatState interface)

- [ ] **Step 1: Add TaskState interface and tasks Map**

Add the `TaskState` interface after the `ChatState` interface (line 39), and add the `tasks` Map to the `Orchestrator` class (after line 53 `private chats`):

```typescript
// After ChatState interface (line 39)
interface TaskState {
  sessionId: string | null;
  cwd: string;
  prompt: string;
}
```

```typescript
// In Orchestrator class, after `private chats = new Map<string, ChatState>();` (line 53)
private tasks = new Map<string, TaskState>();
```

- [ ] **Step 2: Verify types compile**

Run: `npm run check`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: add TaskState interface and tasks Map to orchestrator"
```

### Task 2: Add workspace_create MCP tool

**Files:**
- Modify: `src/orchestrator.ts:487-534` (buildMcpTools method)

- [ ] **Step 1: Add workspace_create tool to buildMcpTools**

In `buildMcpTools` (line 487), add the `workspace_create` tool to the `tools` array, after the existing `send_file` tool. This tool is always available (not behavior-gated like the assistant tools):

```typescript
tool("workspace_create", "Create a new workspace and link it to the current chat", {
  name: z.string().describe("Workspace name (unique, e.g. 'myproject')"),
  cwd: z.string().describe("Absolute path to the workspace directory"),
  behavior: z.enum(["assistant", "relay"]).optional()
    .describe("Workspace behavior mode"),
}, async (args) => {
  // Validate name uniqueness
  if (this.config.workspaceByName(args.name)) {
    throw new Error(`Workspace "${args.name}" already exists. Choose a different name.`);
  }
  // Ensure cwd exists
  fs.mkdirSync(args.cwd, { recursive: true });
  // Create workspace
  this.config.upsertWorkspace({
    name: args.name,
    cwd: args.cwd,
    chat_id: chatId,
    current_session_id: null,
    behavior: args.behavior,
  });
  log.info("[tool] workspace_create: %s → %s (chat %s)", args.name, args.cwd, chatId);
  return { content: [{ type: "text" as const, text: `Workspace "${args.name}" created at ${args.cwd}, linked to this chat.` }] };
}),
```

- [ ] **Step 2: Verify types compile**

Run: `npm run check`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: add workspace_create MCP tool"
```

### Task 3: Add task_complete MCP tool

**Files:**
- Modify: `src/orchestrator.ts:487+` (buildMcpTools method, after workspace_create)

- [ ] **Step 1: Add task_complete tool to buildMcpTools**

Add after `workspace_create` in the tools array:

```typescript
tool("task_complete", "Signal that the current task is complete", {
  message: z.string().optional().describe("Summary of what was accomplished"),
}, async (args) => {
  if (!this.tasks.has(chatId)) {
    throw new Error("No active task for this chat.");
  }
  this.tasks.delete(chatId);
  log.info("[tool] task_complete: chat %s — %s", chatId, args.message ?? "done");
  return { content: [{ type: "text" as const, text: "Task completed." }] };
}),
```

- [ ] **Step 2: Verify types compile**

Run: `npm run check`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: add task_complete MCP tool"
```

---

## Chunk 2: Routing and Task Turn Execution

### Task 4: Update /cancel to handle tasks

**Files:**
- Modify: `src/orchestrator.ts:329-338` (/cancel handler)

- [ ] **Step 1: Update /cancel handler**

Replace the existing `/cancel` block (lines 329-338) with task-aware logic:

```typescript
// /cancel — abort running turn or clear active task
if (msg.text === "/cancel") {
  const task = this.tasks.get(msg.chatId);
  if (task) {
    this.tasks.delete(msg.chatId);
    if (state.abort) state.abort.abort();
    log.info("[cmd] task cancelled for chat %s", msg.chatId);
    await this.channel.sendMessage(msg.chatId, "Setup cancelled.");
    return;
  }
  if (state.abort) {
    state.abort.abort();
    log.info("[cmd] turn cancelled");
  } else {
    await this.channel.sendMessage(msg.chatId, "Nothing to cancel.");
  }
  return;
}
```

- [ ] **Step 2: Verify types compile**

Run: `npm run check`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: /cancel handles active tasks"
```

### Task 5: Add task routing and onboarding trigger

**Files:**
- Modify: `src/orchestrator.ts:365-369` (no-workspace dead-end path)

- [ ] **Step 1: Add task routing above workspace check**

After the `/behavior` handler (line 363) and before the current no-workspace dead-end (line 365), insert task routing. The full replacement of lines 365-371:

```typescript
      // Task routing — takes priority over workspace
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
          log.info("[task] onboarding started for chat %s", msg.chatId);
          this.enqueueTaskMessage(msg, newTask, state);
        } else {
          log.info("[msg] no workspace for chat %s", msg.chatId);
          await this.channel.sendMessage(msg.chatId, "No workspace linked to this chat.");
        }
        return;
      }

      this.enqueueMessage(msg, ws, state);
```

- [ ] **Step 2: Verify types compile (will fail — enqueueTaskMessage doesn't exist yet)**

Run: `npm run check`
Expected: Error about `enqueueTaskMessage` not existing. This is expected — we add it in the next task.

### Task 6: Add enqueueTaskMessage and executeTaskTurn

**Files:**
- Modify: `src/orchestrator.ts` (new methods on Orchestrator class)

- [ ] **Step 1: Add enqueueTaskMessage method**

Add after the existing `enqueueMessage` method (after line 115):

```typescript
/** Enqueue a message for a task session — always immediate drain (no debounce). */
private enqueueTaskMessage(msg: InboundMessage, task: TaskState, state: ChatState): void {
  state.messageQueue.push(msg);
  if (state.busy) return;
  this.processTaskQueue(msg.chatId).catch((err) => {
    log.error({ err }, "[orchestrator] task drain error");
  });
}
```

- [ ] **Step 2: Add processTaskQueue method**

Add after `enqueueTaskMessage`:

```typescript
private async processTaskQueue(chatId: string): Promise<void> {
  const state = this.chat(chatId);
  const task = this.tasks.get(chatId);
  if (state.messageQueue.length === 0 || state.busy || !task) return;

  const messages = [...state.messageQueue];
  state.messageQueue = [];

  try {
    await this.executeTaskTurn(chatId, messages, task, state);
  } catch (err) {
    log.error({ err }, "[fatal]");
    await this.channel.sendMessage(
      chatId,
      `Internal error: ${err instanceof Error ? err.message : String(err)}`,
    ).catch(() => {});
    return;
  }

  // Post-turn drain
  if (state.messageQueue.length > 0 && this.tasks.has(chatId)) {
    this.processTaskQueue(chatId).catch((err) => {
      log.error({ err }, "[orchestrator] task drain error");
    });
  }
}
```

- [ ] **Step 3: Add executeTaskTurn method**

Add after `processTaskQueue`. This mirrors `executeTurn` but uses task fields:

```typescript
private async executeTaskTurn(
  chatId: string,
  messages: InboundMessage[],
  task: TaskState,
  state: ChatState,
): Promise<void> {
  state.busy = true;
  const abort = new AbortController();
  state.abort = abort;

  const turnState = { staySilent: false, replyToMessageId: null as string | null };

  log.info(`[task-turn] start session=${task.sessionId ?? "new"} msgs=${messages.length} cwd=${task.cwd}`);
  await this.channel.setTyping(chatId, true);

  const prompt = buildPrompt(messages);

  const mcpServer = createSdkMcpServer({
    name: "clearclaw",
    tools: this.buildMcpTools(chatId, "relay", turnState),
  });

  try {
    for await (const event of this.engine.runTurn({
      sessionId: task.sessionId,
      cwd: task.cwd,
      prompt,
      permissionMode: "bypassPermissions",
      appendSystemPrompt: task.prompt,
      mcpServers: { clearclaw: mcpServer },
      signal: abort.signal,
      onPermissionRequest: (req) => this.handlePermission(req, chatId),
    })) {
      // Handle done event locally — routeEngineEvent's done handler calls
      // config.setSession(workspaceName, ...) which is workspace-specific.
      // Task turns manage their own session ID.
      if (event.type === "done") {
        log.info(`[task-turn] done session=${event.sessionId}`);
        // Store session ID for multi-turn continuation (if task still exists —
        // task_complete may have deleted it during this turn)
        const currentTask = this.tasks.get(chatId);
        if (currentTask) {
          currentTask.sessionId = event.sessionId;
        }
        if (event.stats) state.stats = event.stats;
        state.toolCallHandle = null;
        state.todoHandle = null;
        break;
      }
      // All other events (text, tool_use, error, rate_limit) route normally
      await this.routeEngineEvent(chatId, event, "", "relay", turnState);
    }
  } finally {
    const cancelled = abort.signal.aborted;
    state.busy = false;
    state.abort = null;
    if (!turnState.staySilent) {
      await this.channel.setTyping(chatId, false);
    }
    if (cancelled) {
      await this.channel.sendMessage(chatId, "Turn cancelled.");
    }
  }
}
```

- [ ] **Step 4: Verify types compile**

Run: `npm run check`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: task routing, enqueue, and turn execution"
```

---

## Chunk 3: Onboarding Skill and Manual Test

### Task 7: Create the onboarding SKILL.md

**Files:**
- Create: `~/.clearclaw/workspace/.claude/skills/onboarding/SKILL.md` (runtime file, not in repo)

- [ ] **Step 1: Create the skill directory and file**

```bash
mkdir -p ~/.clearclaw/workspace/.claude/skills/onboarding
```

Then write the SKILL.md file:

```markdown
---
name: onboarding
description: Set up a new workspace for a chat. Use when the system tells you a chat needs workspace setup.
user-invocable: false
---

# Workspace Onboarding

You're helping set up a new ClearClaw workspace for this chat. The user is already authorized — they just need a workspace linked to this conversation.

## What to do

1. **Ask what they want to work on.** A specific project? A git repo? Or a general-purpose assistant chat?

2. **Find the project.** If they mention a project or repo:
   - Ask for the path, or offer to look in common locations (`~/`, `~/projects/`, `~/src/`, `~/repos/`, `~/workspaces/`)
   - Use `ls` or `find` to locate git repos if they're not sure where it is

3. **Offer a git worktree** (if it's a git repo). Explain the benefit: an isolated copy on its own branch, so the main working tree isn't disturbed. If they want one, run `git worktree add <target_path> -b <branch_name>` from the repo. Use the worktree path as the workspace cwd.

4. **Create the workspace.** Once you have a name and path:
   - Call `workspace_create` with a short, descriptive name and the absolute path
   - For project repos: suggest relay behavior (default)
   - For general-purpose chats: suggest assistant behavior
   - Then call `task_complete` to finish setup

## Guidelines

- Be conversational. Don't dump all questions at once.
- Keep workspace names short: `clearclaw`, `myapp`, `notes` — not `my-awesome-project-workspace`.
- If the user just wants a quick assistant chat (no specific project), create a workspace pointing at `~/.clearclaw/workspace` with assistant behavior.
- If something goes wrong (bad path, name conflict), explain and ask them to try again.
```

- [ ] **Step 2: Verify the file exists**

```bash
cat ~/.clearclaw/workspace/.claude/skills/onboarding/SKILL.md
```

- [ ] **Step 3: No commit needed** — this is a runtime file in the home workspace, not in the repo.

### Task 8: Build and manual test

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 2: Manual test — new group chat**

1. Start the daemon: `npm run dev` (or `npm start`)
2. Add the bot to a new Telegram group (or DM from an authorized account without a workspace)
3. Send a message like "hi"
4. Verify: the bot starts a conversational onboarding flow instead of "No workspace linked"
5. Follow the flow, create a workspace
6. Verify: subsequent messages in that chat route to the new workspace

- [ ] **Step 3: Manual test — /cancel during onboarding**

1. Start onboarding in a new chat
2. Send `/cancel`
3. Verify: "Setup cancelled." message, task cleared
4. Send another message
5. Verify: onboarding starts fresh

- [ ] **Step 4: Commit any fixes from testing**

```bash
git add src/orchestrator.ts
git commit -m "fix: address issues found during manual testing"
```
</content>
</invoke>