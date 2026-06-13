# Auto-Worktree Peers (Phase 1c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** `spin_out` can spawn a peer workspace fully programmatically — chat surface (forum topic), git worktree, workspace binding, brief delivery — with the human approving via buttons; `workspace_archive` tears it all down.

**Architecture:** Humans register forum-enabled groups as *spawn surfaces* (a curated routing rule: surface → workspaces it serves, or default). The registry and resolution are platform-neutral; platform differences live inside Channel implementations. Telegram gains composite chat ids `tg:{chat}:{thread}` — outbound calls funnel through the existing `numericId` chokepoint plus a new `threadOpts` helper; inbound topic messages get the suffix in `extractSender`. Two optional Channel capabilities (`createSubChat`, `closeSubChat`) wrap forum topic create/close. Slack maps later via `conversations.create`/`archive` (no container needed) — out of scope here.

**Tech Stack:** TypeScript (NodeNext, `.js` imports), grammY (`createForumTopic`/`closeForumTopic`, `message_thread_id`), `git worktree` via `node:child_process`.

**Scope:** Telegram only. Builds on Phase 1b (`spin_out` pending-brief flow stays as the manual fallback). Slack `createSubChat` is a follow-on task in TASKS.md.

**Note on testing:** No test runner; `npm run check` plus manual relay verification per repo convention. Pure helpers (id parsing, worktree) get tsx scratch-script smoke tests before the build.

---

## File Structure

- **Modify:** `src/channel/telegram.ts` — composite id parsing, thread-aware sends, topic create/close, inbound suffix
- **Modify:** `src/types.ts` — optional `createSubChat`/`closeSubChat` on `Channel`
- **Modify:** `src/config.ts` — `SpawnSurface` registry + `removeWorkspace`
- **Create:** `src/worktree.ts` — git worktree helpers (repo root, create, remove)
- **Modify:** `src/orchestrator.ts` — `forum_register` (task turns), spawn path in `spin_out`, `workspace_archive` (workspace turns)
- **Modify:** `prompts/ONBOARDING.md` — spawn-surface registration branch
- **Modify:** `docs/TASKS.md` — status update

---

## Task 1: Composite chat ids in TelegramChannel

**Files:** Modify `src/channel/telegram.ts`

Composite form: `tg:{chatId}` (unchanged) or `tg:{chatId}:{threadId}` (forum topic). Chat ids stay opaque strings everywhere else — config, orchestrator, and `workspaceByChat` need zero changes.

- [x] **Step 1:** Replace `numericId` (~line 488) — the current `replace(/^tg:/, "")` would return `NaN` for composite ids — and add `threadOpts`:

```typescript
/** "tg:123" → 123; "tg:123:45" (forum topic) → 123 */
private numericId(chatId: string): number {
  return Number(chatId.split(":")[1]);
}

/** Topic part of a composite chat id, as spreadable send options. */
private threadOpts(chatId: string): { message_thread_id?: number } {
  const thread = chatId.split(":")[2];
  return thread ? { message_thread_id: Number(thread) } : {};
}
```

- [x] **Step 2:** Spread `...this.threadOpts(chatId)` into every message-creating call (message-id-addressed calls — edit, delete, pin, unpin, react — need no thread):
  - `sendMessage` (~lines 164, 169, 176): both branches get an options object, e.g. `this.bot.api.sendMessage(numId, chunk, { ...this.threadOpts(chatId), ...replyParams })` and `{ parse_mode: "MarkdownV2", ...this.threadOpts(chatId), ...replyParams }`
  - `sendInteractive` (~lines 217, 223): both send calls; and the force-reply follow-up prompt (~line 263)
  - `setTyping` (~lines 346, 349): `sendChatAction(numId, "typing", this.threadOpts(chatId))`
  - `sendFile` (~lines 455-462): all four media branches, e.g. `sendPhoto(id, file, { caption, ...this.threadOpts(chatId) })`

- [x] **Step 3:** Inbound suffix in `extractSender` (~line 382):

```typescript
const topicSuffix = ctx.message?.is_topic_message && ctx.message.message_thread_id
  ? `:${ctx.message.message_thread_id}`
  : "";
return {
  chatId: `tg:${ctx.chat.id}${topicSuffix}`,
  chatType: ctx.chat.type === "private" ? "dm" : "group",
  origin: { kind: "user", user },
};
```

(`pendingTextResolvers` is keyed by the chatId passed to `sendInteractive` and resolved by the inbound chatId — both composite now, so they stay consistent. General-topic messages have no `is_topic_message`, so existing group bindings are untouched.)

- [x] **Step 4:** Run `npm run check` — no type errors
- [x] **Step 5:** Smoke-test id parsing with a tsx scratch script: `numericId`/`threadOpts` are private, so test the equivalent expressions inline — `"tg:-100123:45".split(":")` → `["tg", "-100123", "45"]`, `Number("-100123")` → -100123. Delete the script after.
- [x] **Step 6:** Commit: `git add src/channel/telegram.ts && git commit -m "feat(telegram): composite chat ids for forum topics"`

## Task 2: Channel capabilities — createSubChat / closeSubChat

**Files:** Modify `src/types.ts` (Channel interface), `src/channel/telegram.ts`

- [x] **Step 1:** Add optional methods to the `Channel` interface in `src/types.ts` (after `reactToMessage`):

```typescript
/** Create a sub-chat under a registered anchor (Telegram: forum topic in a topics-enabled group). Returns the new chat id. Optional capability. */
createSubChat?(anchor: string, title: string): Promise<string>;
/** Close/archive a sub-chat previously created via createSubChat. Optional capability. */
closeSubChat?(chatId: string): Promise<void>;
```

- [x] **Step 2:** Implement in `TelegramChannel` (near `sendFile`). Requires the bot to be an admin with Manage Topics in the anchor group; errors propagate to the caller:

```typescript
async createSubChat(anchor: string, title: string): Promise<string> {
  const topic = await this.bot.api.createForumTopic(this.numericId(anchor), title);
  return `${anchor}:${topic.message_thread_id}`;
}

async closeSubChat(chatId: string): Promise<void> {
  const thread = chatId.split(":")[2];
  if (!thread) return;
  await this.bot.api.closeForumTopic(this.numericId(chatId), Number(thread));
}
```

- [x] **Step 3:** Run `npm run check` — no type errors (Slack channel compiles unchanged: the methods are optional)
- [x] **Step 4:** Commit: `git add src/types.ts src/channel/telegram.ts && git commit -m "feat(channel): createSubChat/closeSubChat capability (Telegram forum topics)"`

## Task 3: SpawnSurface registry in config

**Files:** Modify `src/config.ts`

- [x] **Step 1:** Add the interface next to `PendingSpinOut`:

```typescript
export interface SpawnSurface {
  name: string;          // registry key, e.g. "dev-forum"
  chat_id: string;       // anchor chat (Telegram forum group)
  workspaces?: string[]; // workspaces whose spin-outs route here
  default?: boolean;     // catch-all when no workspace-bound surface matches
}
```

- [x] **Step 2:** Add `surfaces: SpawnSurface[]` to `ConfigData` and default it in `read()`: `surfaces: (raw.surfaces ?? []) as SpawnSurface[],`

- [x] **Step 3:** Add methods next to the spin-out CRUD:

```typescript
// --- Spawn surfaces ---

addSurface(surface: SpawnSurface): void {
  const data = this.read();
  const idx = data.surfaces.findIndex((s) => s.name === surface.name);
  if (idx >= 0) data.surfaces[idx] = surface;
  else data.surfaces.push(surface);
  this.write(data);
}

listSurfaces(): SpawnSurface[] {
  return this.read().surfaces;
}

/** Bound surface for a workspace, else the default surface, else undefined. */
surfaceForWorkspace(workspaceName: string): SpawnSurface | undefined {
  const surfaces = this.read().surfaces;
  return surfaces.find((s) => s.workspaces?.includes(workspaceName))
    ?? surfaces.find((s) => s.default);
}
```

- [x] **Step 4:** Run `npm run check`, then commit: `git add src/config.ts && git commit -m "feat(config): spawn surface registry"`

## Task 4: forum_register tool + onboarding branch

**Files:** Modify `src/orchestrator.ts` (task-tools block, next to `workspace_create`), `prompts/ONBOARDING.md`

- [x] **Step 1:** Add the tool inside the `if (this.tasks.has(chatId))` block:

```typescript
tool("forum_register", "Register this group as a spawn surface: a topics-enabled (forum) group where ClearClaw creates a topic per spawned peer workspace. The group must have Topics enabled and the bot must be an admin with the Manage Topics right.", {
  name: z.string().describe("Surface name (short, e.g. 'dev-forum')"),
  workspaces: z.array(z.string()).optional()
    .describe("Workspace names whose spin-outs route here"),
  is_default: z.boolean().optional()
    .describe("Use as the catch-all surface when no workspace-bound surface matches"),
}, async (args) => {
  this.config.addSurface({
    name: args.name,
    chat_id: chatId,
    workspaces: args.workspaces,
    default: args.is_default,
  });
  log.info("[tool] forum_register: %s → %s", args.name, chatId);
  return { content: [{ type: "text" as const, text: `Spawn surface "${args.name}" registered for this group. Call task_complete.` }] };
}),
```

- [x] **Step 2:** In `prompts/ONBOARDING.md`, extend the group-chat flow's step 2 ("Ask what they want to work on") with a third possibility:

```markdown
2. **Ask what they want to work on.** A specific project? A git repo? A general-purpose assistant chat? Or is this group a *spawn surface* — a topics-enabled forum where spun-out peer workspaces get their own topics?
   - For a spawn surface: confirm Topics are enabled and the bot is an admin with Manage Topics, ask which workspaces should route here (or whether it's the default catch-all), then call `forum_register` followed by `task_complete`. Skip the remaining steps.
```

- [x] **Step 3:** Run `npm run check`, then commit: `git add src/orchestrator.ts prompts/ONBOARDING.md && git commit -m "feat(onboarding): register forum groups as spawn surfaces"`

## Task 5: Worktree helpers

**Files:** Create `src/worktree.ts`

- [x] **Step 1:** Create the module. Sync `execFileSync` is acceptable: worktree operations are sub-second and rare.

```typescript
import { execFileSync } from "node:child_process";
import path from "node:path";

/** Git repo toplevel containing cwd, or null if not a git repo. */
export function repoRootOf(cwd: string): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

/** Create a worktree at <repoRoot>/.worktrees/<name> on new branch peer/<name>. Returns its path. */
export function createWorktree(repoRoot: string, name: string): string {
  const wtPath = path.join(repoRoot, ".worktrees", name);
  execFileSync("git", ["-C", repoRoot, "worktree", "add", wtPath, "-b", `peer/${name}`], { encoding: "utf-8" });
  return wtPath;
}

/** Remove a worktree by path; resolves the main repo via --git-common-dir so it works from anywhere. */
export function removeWorktree(wtPath: string): void {
  const commonDir = execFileSync("git", ["-C", wtPath, "rev-parse", "--git-common-dir"], { encoding: "utf-8" }).trim();
  const mainRoot = path.dirname(commonDir);
  execFileSync("git", ["-C", mainRoot, "worktree", "remove", "--force", wtPath], { encoding: "utf-8" });
}
```

- [x] **Step 2:** Smoke-test via tsx scratch script against a throwaway git repo in /tmp (init, commit, createWorktree, removeWorktree, assert directory gone). Delete the script after.
- [x] **Step 3:** Run `npm run check`, then commit: `git add src/worktree.ts && git commit -m "feat(worktree): git worktree helpers for peer spawning"`

## Task 6: Spawn path in spin_out

**Files:** Modify `src/orchestrator.ts` (`spin_out` handler). Import `repoRootOf`, `createWorktree` from `./worktree.js`.

When a surface serves the originating workspace and the channel can create sub-chats, offer to spawn immediately; the buttons are the human approval gate (spec: "the human approves"). Manual and cancel paths preserve 1b behavior.

- [x] **Step 1:** Rewrite the `spin_out` handler body:

```typescript
async (args) => {
  const fromName = self?.name ?? "unknown";
  const surface = self ? this.config.surfaceForWorkspace(self.name) : undefined;

  if (surface && this.channel.createSubChat) {
    const resp = await this.channel.sendInteractive(
      chatId,
      `🌱 Spin out "${args.name}"?\n\n${args.brief.slice(0, 300)}`,
      [[
        { label: `Spawn in ${surface.name}`, value: "spawn" },
        { label: "Manual group", value: "manual" },
        { label: "Cancel", value: "cancel" },
      ]],
    );
    if (resp.value === "cancel") {
      return { content: [{ type: "text" as const, text: "Spin-out cancelled by the user." }] };
    }
    if (resp.value === "spawn") {
      if (this.config.workspaceByName(args.name)) {
        return { content: [{ type: "text" as const, text: `Workspace "${args.name}" already exists. Pick another name.` }] };
      }
      try {
        let cwd = args.cwd;
        if (!cwd && self) {
          const repoRoot = repoRootOf(self.cwd);
          cwd = repoRoot ? createWorktree(repoRoot, args.name) : self.cwd;
        }
        const newChatId = await this.channel.createSubChat(surface.chat_id, args.name);
        this.config.upsertWorkspace({
          name: args.name,
          cwd: cwd ?? this.config.homeWorkspacePath,
          chat_id: newChatId,
          current_session_id: null,
          behavior: self?.behavior,
          engine: self?.engine,
        });
        this.deliverToWorkspace(args.name, { kind: "peer", workspaceName: fromName }, args.brief);
        await this.channel.sendMessage(chatId, `🌱 Spawned "${args.name}" as a topic in ${surface.name}.`);
        log.info("[tool] spin_out: spawned %s (cwd %s) in surface %s", args.name, cwd, surface.name);
        return { content: [{ type: "text" as const, text: `Spawned workspace "${args.name}" at ${cwd}; brief delivered.` }] };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Spawn failed: ${detail}. You can retry with a different name, or register the brief for a manual group instead.` }] };
      }
    }
    // resp.value === "manual" falls through to the pending-brief path below
  }

  const entry: PendingSpinOut = {
    id: crypto.randomUUID().slice(0, 8),
    fromWorkspace: fromName,
    name: args.name,
    brief: args.brief,
    suggestedCwd: args.cwd,
    createdAt: Date.now(),
  };
  this.config.addSpinOut(entry);
  await this.channel.sendMessage(chatId, `🌱 Spin-out "${args.name}" registered (${entry.id}). Create a new group, add me to it, and I'll offer to pick this up there.`);
  log.info("[tool] spin_out: %s registered from %s", entry.id, fromName);
  return { content: [{ type: "text" as const, text: `Spin-out ${entry.id} registered. The user creates a new group chat and adds the bot; onboarding there claims the brief.` }] };
},
```

Worktree default: no explicit `cwd` + originator is a git repo → same-repo parallelism, worktree on branch `peer/{name}`. Explicit `cwd` → used as-is (different-repo strand). Non-repo originator → shares the originator's cwd.

- [x] **Step 2:** Update the `spin_out` tool description to cover both paths: `"Propose splitting a related-but-separate strand of work into its own NEW workspace. If a spawn surface is registered, the user is offered one-tap spawning (forum topic + git worktree for same-repo strands); otherwise registers a pending brief the user claims by creating a group. Write the brief as a distilled handoff: the goal plus the few specifics the new agent needs, not a context dump. (To hand a strand to an EXISTING workspace, use message_peer instead.)"`
- [x] **Step 3:** Run `npm run check`, then commit: `git add src/orchestrator.ts && git commit -m "feat(orchestrator): one-tap peer spawning via spawn surfaces"`

## Task 7: workspace_archive teardown

**Files:** Modify `src/config.ts` (removeWorkspace), `src/orchestrator.ts` (tool in workspace-turn block). Import `removeWorktree` from `./worktree.js`; `path` is already imported.

- [x] **Step 1:** Add `removeWorkspace` to config next to `upsertWorkspace`:

```typescript
removeWorkspace(name: string): Workspace | undefined {
  const data = this.read();
  const idx = data.workspaces.findIndex((w) => w.name === name);
  if (idx < 0) return undefined;
  const [removed] = data.workspaces.splice(idx, 1);
  this.write(data);
  return removed;
}
```

- [x] **Step 2:** Add the tool after `spin_out_cancel`:

```typescript
tool("workspace_archive", "Archive a workspace: unbind it from its chat, close its topic (if it was spawned into a forum), and remove its git worktree (if under .worktrees). The directory contents and git branch otherwise survive. Cannot archive 'default'.", {
  name: z.string().describe("Workspace to archive"),
}, async (args) => {
  if (args.name === "default") {
    return { content: [{ type: "text" as const, text: "Cannot archive the home workspace." }] };
  }
  const target = this.config.workspaceByName(args.name);
  if (!target) {
    return { content: [{ type: "text" as const, text: `No workspace named "${args.name}".` }] };
  }
  const resp = await this.channel.sendInteractive(
    chatId,
    `Archive workspace "${args.name}" (${target.cwd})?`,
    [[{ label: "Archive", value: "yes" }, { label: "Cancel", value: "no" }]],
  );
  if (resp.value !== "yes") {
    return { content: [{ type: "text" as const, text: "Archive cancelled by the user." }] };
  }
  this.config.removeWorkspace(args.name);
  if (this.channel.closeSubChat && target.chat_id.split(":").length > 2) {
    await this.channel.closeSubChat(target.chat_id).catch((err) =>
      log.warn("[tool] workspace_archive: failed to close topic: %s", err instanceof Error ? err.message : String(err)));
  }
  if (target.cwd.includes(`${path.sep}.worktrees${path.sep}`)) {
    try { removeWorktree(target.cwd); } catch (err) {
      log.warn("[tool] workspace_archive: worktree removal failed, leaving directory: %s", err instanceof Error ? err.message : String(err));
    }
  }
  log.info("[tool] workspace_archive: %s", args.name);
  return { content: [{ type: "text" as const, text: `Workspace "${args.name}" archived.` }] };
}),
```

- [x] **Step 3:** Run `npm run check`, then commit: `git add src/config.ts src/orchestrator.ts && git commit -m "feat(orchestrator): workspace_archive teardown for spawned peers"`

## Task 8: Manual end-to-end verification

- [ ] **Step 1:** `npm run build` (explicit; restarts dev:relay)
- [ ] **Step 2:** Regression: existing chats (DM + project groups) send/receive normally — composite-id parsing must not disturb plain ids
- [ ] **Step 3:** Create a Telegram group, enable Topics, add the bot as admin with Manage Topics; onboarding → register as spawn surface (e.g. `dev-forum`, default)
- [ ] **Step 4:** From the `clearclaw` workspace chat: ask the agent to spin out a strand. Expect buttons; tap "Spawn in dev-forum" → topic appears, worktree under `.worktrees/`, brief lands as `[from clearclaw]: ...`, peer responds in the topic under its own permission mode
- [ ] **Step 5:** Converse in the topic; verify status pin, tool messages, and `message_peer` back to the originator
- [ ] **Step 6:** `workspace_archive` the peer → confirm buttons → topic closes, worktree removed, config entry gone
- [ ] **Step 7:** Fallback paths: "Manual group" button registers a pending brief (1b flow); spin_out with no surface registered goes straight to the pending-brief path
- [ ] **Step 8:** Fix and commit; update TASKS.md (tick 1c, add Slack createSubChat follow-on)

## Self-review notes

- **Spec coverage:** spawn surfaces implement the human-provisioned routing-rule decision (spec Part 1 addendum); one-tap spawn covers "auto-spawned worktree agents"; lifespan/isolation dials surface as explicit cwd vs worktree default and archive-on-demand; approval rides buttons (the relay), not a separate model.
- **Branching audit:** orchestrator and config are platform-neutral — the only platform-specific code is inside `TelegramChannel` (`threadOpts`, `createSubChat`, `closeSubChat`), mirroring how `sendMessage` already works. Slack later implements the same two optional methods with `conversations.create`/`archive` and ignores the anchor.
- **Type consistency:** `SpawnSurface`/`PendingSpinOut` both live in config.ts; `spin_out` spawn path reuses `upsertWorkspace` + `deliverToWorkspace` exactly as 1b's claim path does; `worktree.ts` exports match call sites (`repoRootOf`, `createWorktree` in Task 6; `removeWorktree` in Task 7).
- **Known edges:** branch name collisions (`peer/{name}` exists) surface as tool errors with retry guidance; topic-pin status falls back gracefully (existing updateStatus path); archiving leaves directories when git refuses removal.
