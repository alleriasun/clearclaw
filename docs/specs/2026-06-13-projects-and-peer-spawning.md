# Projects and Peer Spawning (Phase 1c, design)

> Refines the auto-worktree-peers plan (`docs/plans/2026-06-12-auto-worktree-peers.md`) after a naming and modeling pass. This spec is the canonical terminology and data model; the plan is the original build recipe and predates these names.

## Context

Phase 1b shipped `spin_out`: an agent proposes splitting a strand into a new workspace, the human approves by creating a chat, the new workspace is seeded with a brief. 1c adds programmatic spawning: the agent creates the new chat itself (Telegram forum topic + git worktree) with one tap, and can tear it down. This spec settles what a "project" is, how a workspace / its main / its peers relate, and keeps it platform-neutral.

## Terminology

**Workspace** — an agent bound to one chat; runs turns, holds a session. Belongs to a project when one is set (always for newly-onboarded workspaces).
`{ name, cwd, chat_id, current_session_id, behavior?, engine?, project?, description?, spawnedFrom?, owns_worktree? }`

**Project** — a named body of work and its shared context: what a set of workspaces is collectively about. Not an agent; holds no session.
`{ name, description, main_workspace }`
- `name` — registry key (matches its main workspace's name)
- `description` — what the project is about; shared context across its workspaces (and the future home for shared project memory)
- `main_workspace` — the trunk; its chat is the spawn container, its cwd the repo root

**main** — the project's trunk workspace: onboarded (not spawned), `spawnedFrom` absent, living in the project's main chat (Telegram General) on the repo's main branch. Its cwd is the real checkout.

**peer** — a workspace spawned via `spin_out`: `spawnedFrom` set, living in its own spawned chat and working directory. The directory may be an externally prepared worktree or a standard worktree ClearClaw creates when `cwd` is omitted. Disposable; archivable.

**spawnedFrom** — the spawner workspace; set on peers, absent on mains. Drives `workspace_archive` teardown and records provenance.

**owns_worktree** — true only when ClearClaw created the peer's worktree; false marks a caller-owned external path. Absent means no worktree or legacy ownership is unknown. ClearClaw removes only true-owned worktrees during rollback or archive.

## Decisions

**chat_id is opaque to the orchestrator.** Only the channel parses it (Telegram `tg:{group}:{topic}` vs `tg:{group}`). The orchestrator binds and routes by the opaque string.

**Projects are created at onboarding; the link is optional for legacy.** Onboarding any new workspace creates its project (that workspace as `main_workspace`) and sets `project`; the DM becomes the main of the `default` project. Peers attach to the target project (`project` set, no new Project). The field is **optional**, though: workspaces that predate this — or plain non-forum channels — have no project and are fully supported. They simply can't one-tap-spawn (`spin_out` falls back to the manual brief, or targets another project via `into`). Designating an existing workspace into a project is a deliberate user action (enable Topics / point it at a project), never automatic. No forced migration, no headless project.

**Each platform spawns its best full-fledged surface; no forced threads.** A Telegram topic is a full-fledged conversation from a UX view, so its honest analog on Slack/Discord is a new channel, not a thread. `createChat(anchor, title)` / `closeChat(chatId)` return/accept an opaque chat_id; each channel picks the mechanism. (Rejected: mapping topic to thread everywhere, which would cram Slack/Discord users into one-thread-per-session.)

**Project sections are a channel capability, not a Project field.** Slack mirrors each Project into one shared sidebar section backed by a User Group. The display name is the Project name, the mention handle is `cc-<project-slug>` with a stable hash fallback on collision, members are authorized Slack users, and default channels are the Project main plus every live peer. ClearClaw marks groups it owns and never updates or disables an unmarked group. The orchestrator exposes only optional section sync/remove capabilities; Slack-specific User Group details stay in the Slack adapter. Sync is best-effort and reconciles at startup, spawn, workspace creation, and archive, so sidebar failures never roll back workspace lifecycle.

**Spawn target is the project's main chat; no override.** `spin_out(name, brief, cwd?, into?)` resolves the target project as `into ?? self.project`, then spawns into `target.main_workspace`'s chat. One-tap spawning requires that project to resolve, its main workspace to exist, and the active channel to implement `createChat`; otherwise it falls back to the 1b pending-brief flow and reports why. There is no separate spawn-surface field and no default catch-all.

**Archive by marker and ownership.** `workspace_archive` identifies a peer by `spawnedFrom`, delegates chat teardown to `closeChat`, and removes its worktree only when `owns_worktree` is true. Caller-owned and legacy-unknown directories stay in place. Archiving a main also drops its project — but is **refused while that project still has live peers** (archive those first, or reassign the main via `project_update`), so peers are never left pointing at a dropped project. This avoids the orchestrator sniffing chat_id shape and protects human-created groups and worktrees.

**Transactional spawn + explicit worktree ownership.** An explicit `cwd` must already exist and stays owned by the caller. When `cwd` is omitted, ClearClaw may create a standard git worktree and records `owns_worktree: true`. Spawn rollback and archive remove only owned worktrees; external paths stay in place for cleanup by their own tooling. Owned worktree removal uses `git branch -d`, so a branch with real unmerged work is kept. A spawned peer inherits `behavior` / `engine` from its project's main, not from whoever spawned it.

**Editable context (the P2 seam).** `Project.description` and `Workspace.description` are the editable context pair — what the project, and a given workspace, are about / working on (same field name, entity-scoped). Set at creation/spawn (a peer's `description` is its brief) and changed via `project_update` / `workspace_update`. They're persisted for Phase 2 and not yet read into prompts — intentional groundwork, not dead code. This is the context layer Phase 2's shared memory builds on.

## Cross-platform mapping

- **Telegram:** main chat = a forum group's General; peer = a topic (`createForumTopic`) giving `tg:{group}:{topic}`; close = `closeForumTopic`. Requires Topics enabled and the bot admin with Manage Topics.
- **Slack:** main chat = a channel; peer = a new private channel (`conversations.create`) giving `slack:{channel}`; close = `conversations.archive`; Project grouping = a shared sidebar section backed by a `cc-<project-slug>` User Group.
- **Discord (future):** channel + channel/thread; same opaque-id shape.

## Flows

- **Home / DM:** `Workspace { name:"default", behavior:"assistant", project:"default" }` + `Project { name:"default", description:<personal context>, main_workspace:"default" }`. Spin-out uses one-tap spawning when the active channel implements `createChat`; otherwise it goes 1b or targets another capable project via `into`.
- **New repo project:** `workspace_create` makes `Workspace { name:"clearclaw", project:"clearclaw" }` + `Project { name:"clearclaw", description, main_workspace:"clearclaw" }`. Peers can spawn when that channel implements `createChat`.
- **Spin out a peer:** from any member, `spin_out` resolves the project, `createChat(main's chat, name)` gives a new chat, and creates `Workspace { chat_id:<peer chat>, project:"clearclaw", spawnedFrom:<spawner>, owns_worktree:<ownership> }`; the brief is delivered as its first message.

## Status

Built and verified end to end on `feat/spin-out`: spawn → worktree → forum topic → brief delivery → peer `message_peer` round-trip → archive, plus the error paths (permission failure, branch collision) failing cleanly with rollback. Ready to merge to main.
