# Projects and Peer Spawning (Phase 1c, design)

> Refines the auto-worktree-peers plan (`docs/plans/2026-06-12-auto-worktree-peers.md`) after a naming and modeling pass. This spec is the canonical terminology for the spawning model; the plan is the original build recipe and predates these names.

## Context

Phase 1b shipped `spin_out`: an agent proposes splitting a strand into a new workspace, the human approves by creating a chat, the new workspace is seeded with a brief. 1c adds programmatic spawning: the agent creates the new chat itself (Telegram forum topic + git worktree) with one tap, and can tear it down later. This spec settles what the registered "where do peers spawn" entity is, and how it stays platform-neutral.

## Terminology

**Workspace** — an agent bound to one chat; runs turns, holds a session.
`{ name, cwd, chat_id, current_session_id, behavior?, engine?, spawnedFrom? }`

**Project** — a routing entry tying a chat anchor (channel side) to a set of workspaces (engine side); the place where new peer workspaces get spawned. Not an agent, no session.
`{ name, anchor, workspaces?, default? }`
- `name` — registry key + label (e.g. shown on the spawn button)
- `anchor` — the chat the project is anchored to (Telegram forum group; Slack lead channel). The channel interprets it.
- `workspaces?` — workspace names whose spin-outs route here
- `default?` — catch-all when no workspace-bound project matches

Resolution (`projectForWorkspace`): bound project, else default project, else none (fall back to the 1b manual brief).

A project's identity is its **anchor**, not a repo. Two forum groups pointed at the same repo are two projects.

**trunk / peer** — roles, not fields. The trunk is the workspace in a project's main area (Telegram General) on the repo's main branch. A peer is a workspace spawned via `spin_out`, living in its own spawned chat on a worktree branch `peer/{name}`. Both are plain Workspaces; only `chat_id` / `cwd` / `spawnedFrom` differ. Otherwise "peer" is just the cross-workspace message label (`MessageOrigin { kind: "peer" }`).

**spawnedFrom** — set on a Workspace spawned via `spin_out` (the origin workspace name). Drives `workspace_archive` teardown and records provenance.

## Decisions

**chat_id is opaque to the orchestrator.** Only the channel parses it. Telegram encodes a topic as `tg:{group}:{topic}` and a flat chat as `tg:{group}`; Slack would use `slack:{channel}`. The orchestrator binds and routes by the opaque string; `numericId` / thread parsing live in TelegramChannel.

**Each platform spawns its best full-fledged surface; no forced uniformity.** A Telegram forum topic is a full-fledged conversation from a UX view, so its honest analog on Slack/Discord is a new channel, not a thread. We rejected mapping topic to thread everywhere: it would cram Slack/Discord users into one-thread-per-session to satisfy a symmetry that only serves Telegram. The Channel methods `createChat(anchor, title)` / `closeChat(chatId)` return/accept an opaque chat_id; each channel picks the mechanism.

**Projects are optional routing config.** If a relevant project exists for the originating workspace (bound, else default), `spin_out` offers one-tap spawn; otherwise it falls back to the 1b pending-brief flow.

**Archive by marker, not by id shape.** `workspace_archive` tears down the chat and worktree only when `spawnedFrom` is set, and delegates closing to `closeChat` (a no-op when there is nothing to close). This avoids the orchestrator sniffing chat_id structure (which broke the moment a Slack peer is a flat-id channel) and protects human-created groups from teardown.

## Cross-platform mapping

- **Telegram:** anchor = forum group; spawn = topic (`createForumTopic`) giving `tg:{group}:{topic}`; close = `closeForumTopic`. Requires Topics enabled and the bot admin with Manage Topics.
- **Slack (follow-on):** anchor = a channel; spawn = a new channel (`conversations.create`, named from the anchor) giving `slack:{channel}`; close = `conversations.archive`. Scopes verified at implementation.
- **Discord (future):** anchor = a channel; spawn = a channel or thread giving `discord:{...}`; same opaque-id shape.

## Status

Renamed and type-checked on `feat/spin-out`. Pending build + live Telegram verification (plan Task 8).
