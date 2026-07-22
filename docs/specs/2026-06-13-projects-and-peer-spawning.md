# Projects and Peer Spawning (Phase 1c, design)

> Refines the auto-worktree-peers plan (`docs/plans/2026-06-12-auto-worktree-peers.md`) after a naming and modeling pass. This spec is the canonical terminology and data model; the plan is the original build recipe and predates these names.

## Context

Phase 1b shipped `spin_out`: an agent proposes splitting a strand into a new workspace, the human approves by creating a chat, the new workspace is seeded with a brief. 1c adds programmatic spawning: the agent creates the new chat itself (Telegram forum topic + git worktree) with one tap, and can tear it down. This spec settles what a "project" is, how a workspace / its main / its peers relate, and keeps it platform-neutral.

## Terminology

**Workspace** — an agent bound to one chat; runs turns, holds a session. Belongs to a project when one is set (always for newly-onboarded workspaces).
`{ name, cwd, chat_id, current_session_id, behavior?, engine?, project?, description?, spawnedFrom? }`

**Project** — a named body of work and its shared context: what a set of workspaces is collectively about. Not an agent; holds no session.
`{ name, description, main_workspace }`
- `name` — registry key (matches its main workspace's name)
- `description` — what the project is about; shared context across its workspaces (and the future home for shared project memory)
- `main_workspace` — the trunk; its chat is the spawn container, its cwd the repo root

**main** — the project's trunk workspace: onboarded (not spawned), `spawnedFrom` absent, living in the project's main chat (Telegram General) on the repo's main branch. Its cwd is the real checkout.

**peer** — a workspace spawned via `spin_out`: `spawnedFrom` set, living in its own spawned chat (Telegram topic) on a worktree branch `peer/{name}`. Disposable; archivable.

**spawnedFrom** — the spawner workspace; set on peers, absent on mains. Drives `workspace_archive` teardown and records provenance.

## Decisions

**chat_id is opaque to the orchestrator.** Only the channel parses it (Telegram `tg:{group}:{topic}` vs `tg:{group}`). The orchestrator binds and routes by the opaque string.

**Projects are created at onboarding; the link is optional for legacy.** Onboarding any new workspace creates its project (that workspace as `main_workspace`) and sets `project`; the DM becomes the main of the `default` project. Peers attach to the target project (`project` set, no new Project). The field is **optional**, though: workspaces that predate this — or plain non-forum channels — have no project and are fully supported. They simply can't one-tap-spawn (`spin_out` falls back to the manual brief, or targets another project via `into`). Designating an existing workspace into a project is a deliberate user action (enable Topics / point it at a project), never automatic. No forced migration, no headless project.

**Each platform spawns its best full-fledged surface; no forced threads.** A Telegram topic is a full-fledged conversation from a UX view, so its honest analog on Slack/Discord is a new channel, not a thread. `createChat(anchor, title)` / `closeChat(chatId)` return/accept an opaque chat_id; each channel picks the mechanism. (Rejected: mapping topic to thread everywhere, which would cram Slack/Discord users into one-thread-per-session.)

**Spawn target is the project's main chat; no override.** `spin_out(name, brief, cwd?, into?)` resolves the target project as `into ?? self.project`, then spawns into `target.main_workspace`'s chat. If that chat is a forum, the user gets one-tap topic spawning (topic + worktree off the project's repo); if not (DM or plain group), it falls back to the 1b pending-brief flow. There is no separate spawn-forum field and no default catch-all: to spawn topic-peers, the main's chat must be a forum, else use `into` a forum project or the manual flow.

**Archive by marker.** `workspace_archive` tears a peer down by `spawnedFrom` (delegating "what closing means" to `closeChat`, which no-ops when there's nothing to close, plus worktree removal). Archiving a main also drops its project — but is **refused while that project still has live peers** (archive those first, or reassign the main via `project_update`), so peers are never left pointing at a dropped project. This avoids the orchestrator sniffing chat_id shape and protects human-created groups.

**Transactional spawn + safe branch lifecycle.** Spawn rolls back best-effort: on any failure it removes the worktree it created (and its still-clean branch) and closes the topic it created, so a failed spawn leaves nothing behind. Archive removes the worktree and `git branch -d`s the peer branch only when it is fully merged; a branch with real unmerged work is kept. A spawned peer inherits `behavior` / `engine` from its project's main, not from whoever spawned it.

**Editable context (the P2 seam).** `Project.description` and `Workspace.description` are the editable context pair — what the project, and a given workspace, are about / working on (same field name, entity-scoped). Set at creation/spawn (a peer's `description` is its brief) and changed via `project_update` / `workspace_update`. They're persisted for Phase 2 and not yet read into prompts — intentional groundwork, not dead code. This is the context layer Phase 2's shared memory builds on.

## Cross-platform mapping

- **Telegram:** main chat = a forum group's General; peer = a topic (`createForumTopic`) giving `tg:{group}:{topic}`; close = `closeForumTopic`. Requires Topics enabled and the bot admin with Manage Topics.
- **Slack (follow-on):** main chat = a channel; peer = a new channel (`conversations.create`) giving `slack:{channel}`; close = `conversations.archive`.
- **Discord (future):** channel + channel/thread; same opaque-id shape.

## Flows

- **Home / DM:** `Workspace { name:"default", behavior:"assistant", project:"default" }` + `Project { name:"default", description:<personal context>, main_workspace:"default" }`. Spin-out here can't topic-spawn (a DM isn't a forum), so it goes 1b or `into` a forum project.
- **New repo project (forum group):** `workspace_create` makes `Workspace { name:"clearclaw", project:"clearclaw" }` (in General) + `Project { name:"clearclaw", description, main_workspace:"clearclaw" }`. Peers spawn here as topics.
- **Spin out a peer:** from any member, `spin_out` resolves the project, `createChat(main's chat, name)` gives a topic, and creates `Workspace { chat_id:<topic>, project:"clearclaw", spawnedFrom:<spawner> }` on a worktree `peer/{name}`; the brief is delivered as its first message.

## Status

Built and verified end to end on `feat/spin-out`: spawn → worktree → forum topic → brief delivery → peer `message_peer` round-trip → archive, plus the error paths (permission failure, branch collision) failing cleanly with rollback. Ready to merge to main.
