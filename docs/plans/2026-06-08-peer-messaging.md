# Peer Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent in one workspace send a message to another workspace, delivered as a turn there, with the other side able to reply the same way, the "wire" of the peer-agent fabric. (All workspaces are the same mind in different rooms; "peer" is the topology, not a separate identity.)

**Architecture:** Reuse the existing turn machinery. Message provenance is a typed `MessageOrigin` union (user / scheduler / peer). A new `message_peer` MCP tool builds a `{ kind: "peer", workspaceName }` message and hands it to a generalized `deliverToWorkspace()` (extracted from the scheduler's `injectMessage`), which enqueues it on the target chat's queue. The target processes it as a normal turn under its own permission behavior and renders it in its chat; it replies by calling `message_peer` back. Switchboard, not boss.

**Tech stack:** TypeScript (NodeNext, `.js` imports), the in-process `clearclaw` MCP server, the existing per-chat message queue.

**Scope:** Tracer bullet, peer-to-peer delivery + reply. Spin-out and auto-worktree spawning are follow-on plans. Shared memory / awareness is Phase 2 (`docs/specs/2026-06-07-peer-agents-and-memory.md`).

**Note on testing:** ClearClaw has no test runner; it is verified by `npm run check` (tsc --noEmit) plus manual relay testing, its established workflow. Each task type-checks and commits; a final task verifies end-to-end manually. For the type refactor, the compiler is the test: changing the type surfaces every call site to fix.

---

## Implementation Tasks

### Task 0: Model message provenance as a typed origin union

Replace the fragile conventions (`injected: boolean` + synthetic `user.id` prefixes) with one discriminated union, the foundation everything builds on. Pure refactor: behavior is unchanged for user and scheduler messages; the `peer` case is defined now but only produced in Task 3.

**Files:**
- Modify: `src/types.ts` (add `MessageOrigin`, change `InboundMessage`)
- Modify: `src/channel/telegram.ts`, `src/channel/slack.ts` (inbound construction)
- Modify: `src/orchestrator.ts` (`buildPrompt`, `executeTurn`, `injectMessage`) and `src/scheduler.ts` (inject wiring)

- [ ] **Step 1: Add the union and update `InboundMessage` in `src/types.ts`**

```typescript
export type MessageOrigin =
  | { kind: "user"; user: UserInfo }
  | { kind: "scheduler"; scheduleId: string }
  | { kind: "peer"; workspaceName: string }; // another workspace: same mind, different room
```
In `InboundMessage`, remove `user: UserInfo` and `injected?: boolean`, and add `origin: MessageOrigin;`.

- [ ] **Step 2: Let the compiler find every reader**

Run: `npm run check`
Expected: FAILS with type errors at each old `.user` / `.injected` access. Fix each (Steps 3-6) until green.

- [ ] **Step 3: Channels construct a user origin**

In `telegram.ts` and `slack.ts`, where the inbound message is built with `user: {...}`, replace with:
```typescript
origin: { kind: "user", user: { id, name, handle } },
```
(remove the separate `user` and any `injected` fields)

- [ ] **Step 4: Scheduler builds a scheduler origin**

In `injectMessage` (`src/orchestrator.ts`) construct `origin: { kind: "scheduler", scheduleId }`, and update the Scheduler inject callback (`src/scheduler.ts` + the wiring in `orchestrator.ts` `start()`) to pass the schedule id + text instead of a synthetic user.

- [ ] **Step 5: Attribution from origin in `buildPrompt` (`src/orchestrator.ts` ~line 880)**

Add a helper and use it where the old `sender` + `systemTag` logic was:
```typescript
function senderLabel(origin: MessageOrigin): string {
  switch (origin.kind) {
    case "user": return origin.user.handle ? `${origin.user.name} (@${origin.user.handle})` : origin.user.name;
    case "scheduler": return "[system] Scheduler";
    case "peer": return `[from ${origin.workspaceName}]`;
  }
}
```

- [ ] **Step 6: Behavior from origin in `executeTurn` (`src/orchestrator.ts` ~line 231)**

```typescript
const behavior = messages.some((m) => m.origin.kind === "scheduler")
  ? "assistant" as const
  : this.effectiveBehavior(ctx);
```
Scheduler stays hands-off; user and peer use the workspace's natural behavior, the permission-safety fix, baked in.

- [ ] **Step 7: Type-check green, then commit**

```bash
npm run check
git add -A
git commit -m "refactor: model InboundMessage provenance as a typed MessageOrigin union"
```

### Task 1: Expose the workspace roster

**Files:**
- Modify: `src/config.ts` (next to `workspaceByName` / `workspaceByChat`, ~line 295)

- [ ] **Step 1: Add a public `listWorkspaces()` method**

```typescript
listWorkspaces(): Workspace[] {
  return this.read().workspaces;
}
```

- [ ] **Step 2: Type-check** — Run `npm run check`. Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(config): expose listWorkspaces() for peer addressing"
```

---

### Task 2: Generalize delivery to any workspace

Extract a general `deliverToWorkspace()` so the scheduler and peer messaging share one delivery path.

**Files:**
- Modify: `src/orchestrator.ts` (`injectMessage`, ~lines 132-150)

- [ ] **Step 1: Replace `injectMessage` with `deliverToWorkspace` + a thin `injectMessage`**

```typescript
/** Deliver a synthetic message to a named workspace and trigger its turn. */
public deliverToWorkspace(workspaceName: string, origin: MessageOrigin, text: string): boolean {
  const ws = this.config.workspaceByName(workspaceName);
  if (!ws) {
    log.warn("[deliver] workspace '%s' not found", workspaceName);
    return false;
  }
  const msg: InboundMessage = {
    chatId: ws.chat_id,
    chatType: ws.name === "default" ? "dm" : "group",
    text,
    origin,
  };
  this.enqueueMessage(msg, ws, this.chat(ws.chat_id));
  return true;
}

/** Scheduler entry point: deliver to the home workspace. */
public injectMessage(scheduleId: string, text: string): void {
  if (!this.deliverToWorkspace("default", { kind: "scheduler", scheduleId }, text)) {
    log.warn("[inject] home workspace 'default' not found");
  }
}
```
(Update the Scheduler wiring from Task 0 Step 4 so it calls `injectMessage(id, text)`.)

- [ ] **Step 2: Type-check** — Run `npm run check`. Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator.ts src/scheduler.ts
git commit -m "refactor(orchestrator): extract deliverToWorkspace from injectMessage"
```

### Task 3: Add the `message_peer` MCP tool

Lets the current agent message another workspace. Available in workspace turns (not task turns). Its description lists the reachable workspaces so the agent knows valid targets.

**Files:**
- Modify: `src/orchestrator.ts` — inside `buildMcpTools` (~line 646), in the workspace-turn block (`if (!this.tasks.has(chatId) && this.scheduler)`, ~lines 708-753).

- [ ] **Step 1: Add the tool**

```typescript
// Cross-workspace handoff: deliver a message as a turn in another workspace.
const self = this.config.workspaceByChat(chatId);
const peers = this.config.listWorkspaces().filter((w) => w.name !== self?.name);
const peerList = peers.length ? peers.map((w) => `"${w.name}"`).join(", ") : "(none)";
tools.push(
  tool(
    "message_peer",
    `Send a message to another of your workspaces. It is delivered as a turn there and rendered in that chat; it can reply by calling message_peer back. Reachable workspaces: ${peerList}.`,
    {
      workspace: z.string().describe("Target workspace name (one of the reachable workspaces)"),
      message: z.string().describe("The message to send"),
    },
    async (args) => {
      const target = this.config.workspaceByName(args.workspace);
      if (!target) {
        return { content: [{ type: "text" as const, text: `No workspace named "${args.workspace}". Reachable: ${peerList}.` }] };
      }
      if (self && target.name === self.name) {
        return { content: [{ type: "text" as const, text: "Cannot message yourself." }] };
      }
      const fromName = self ? self.name : "unknown";
      const ok = this.deliverToWorkspace(target.name, { kind: "peer", workspaceName: fromName }, args.message);
      if (!ok) {
        return { content: [{ type: "text" as const, text: `Failed to deliver to "${args.workspace}".` }] };
      }
      await this.channel.sendMessage(chatId, `→ sent to ${target.name}: ${args.message}`);
      log.info("[tool] message_peer: %s → %s", fromName, target.name);
      return { content: [{ type: "text" as const, text: `Delivered to ${target.name}.` }] };
    },
  ),
);
```

- [ ] **Step 2: Type-check** — Run `npm run check`. Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat(orchestrator): add message_peer cross-workspace handoff tool"
```

**Note:** `message_peer` is `mcp__clearclaw__message_peer`, auto-allowed in `handlePermission` (~line 785), so it sends without a prompt; visibility is the rendered "→ sent to" note + the message landing in the target chat. To gate sends, exclude it from that auto-allow.

---

### Task 4: Manual end-to-end verification

- [ ] **Step 1:** Two workspaces exist, each bound to a chat (e.g. `default` + `myapp`).
- [ ] **Step 2:** `npm run build` then `npm run dev:relay` (or `npm run dev`).
- [ ] **Step 3:** In `default`'s chat: "message the myapp workspace: what are you working on?" Expect a `message_peer` call and `→ sent to myapp: ...` in default's chat.
- [ ] **Step 4:** In `myapp`'s chat: a new turn shows `[from default]: what are you working on?` and myapp responds in its own chat, under its own permission behavior (not bypass).
- [ ] **Step 5:** myapp replies via `message_peer` targeting `default`; it lands in default's chat as `[from myapp]: ...`.
- [ ] **Step 6:** Confirm no runaway loop, threads end when a side stops.

---

## Follow-on plans (not in this plan)

- **Phase 1b, Spin-out:** agent proposes splitting a related strand; human approves; route via `message_peer` or spawn a new workspace (`workspace_create`).
- **Phase 1c, Auto-worktree:** spawn an ephemeral worktree + workspace + channel for same-repo parallelism.
- **Phase 2, Shared memory (STM/LTM):** per `docs/specs/2026-06-07-peer-agents-and-memory.md`.

## Self-review notes

- **Spec coverage:** implements Part 1's handoff-as-tool, explicit symmetric texting, natural termination, and (via Task 0) typed provenance + permission inheritance. Spin-out + worktree deferred to 1b/1c; memory is Phase 2.
- **Type consistency:** `MessageOrigin` (user/scheduler/peer) is the single discriminator; `deliverToWorkspace(name, origin, text)`, `listWorkspaces`, `message_peer` consistent across tasks.
- **No placeholders:** code shown in every code step; the refactor uses the compiler as the test; Task 4 is manual.
