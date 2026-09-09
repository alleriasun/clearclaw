# Decision: Projects and peer spawning

## Status

Accepted for the peer lifecycle. Moving worktree preparation out of the tool is an accepted follow-up direction, tracked in [#46](https://github.com/alleriasun/clearclaw/issues/46), and is not yet implemented.

This record preserves the architectural choices and their consequences. Update its status or supersede the decision when those choices change; execution plans and verification logs belong outside the spec.

## Context

Related work often needs a separate conversation and working directory. A peer is an ongoing workspace the human can steer directly, with its own engine session. It receives a distilled brief and can communicate with existing workspaces through `message_peer`.

ClearClaw supplies transport and lifecycle operations. The human and agents decide what work belongs together. A peer is not a subordinate agent whose result must return to a supervisor, and spawning does not introduce an agent that plans or assigns everyone's work. Workspace chats provide separate contexts without requiring a separate bot identity for every agent.

A new strand normally gets a new workspace; a true continuation can use an existing peer. Working-directory isolation and workspace lifetime are independent choices. A long-lived worktree is valid, and a non-git workspace can share a directory when that is intended.

## Decision

### Model

A **Workspace** binds a unique name, working directory, chat, and current engine session. Its optional `project` identifies the Project it belongs to. `engine`, `model`, and `behavior` control its runtime. `description` records what it is working on.

A **Project** has a unique name, a description, and a `main_workspace`. It holds shared context and identifies the spawning baseline; it has no engine session. Project names need not match workspace names.

The **main workspace** supplies the Project's spawn destination, directory baseline, and default runtime. Automatically spawned **peers** join that Project and record their originating workspace in `spawnedFrom`. Chat closure does not depend on that provenance. Worktree ownership is a separate field, `owns_worktree`.

New onboarding creates a Project with the new workspace as main. Existing workspaces may remain unprojected. `project_create` adopts an existing unprojected workspace, defaulting to the caller, and rejects duplicate Projects or silent reassignment. This avoids forced migration and Projects with no main.

`Project.description` and `Workspace.description` are editable context. A spawned peer's brief becomes its description. These fields are stored but are not currently injected into prompts as shared project memory.

### Proposal and handoff

`spin_out` targets the Project selected by `into`, otherwise the caller's Project. It resolves the Project main and runtime before proposing the handoff. The main chat is the spawn destination; there is no separate spawn-surface registry or global catch-all.

When the Project, main workspace, and channel's Project lifecycle capability are available, the user chooses **Spawn**, **Manual group**, or **Cancel**. Automatic spawning selects a directory, creates the platform chat with its lifecycle grouping update, persists the peer, and queues the brief as a peer message.

If a prerequisite is missing, or the user chooses a manual group, ClearClaw persists a pending brief and reports the reason. A failed automatic spawn reports failure; it does not silently create a pending claim. `spin_out_cancel` removes an unclaimed brief.

A pending record carries an ID, originating workspace, suggested name and cwd, brief, chosen runtime, and creation time. In a new chat, onboarding claims it through `workspace_create(spin_out_id)` and then finishes with `task_complete`, allowing the queued brief to run as a workspace turn. Manual onboarding creates a new Project around that workspace; it does not attach the claim to the originating Project. The suggested cwd is a default for onboarding, not a prepared worktree.

The brief conveys the goal, decisions the human has already made, and scope. Implementation choices stay with the receiving workspace unless the human has specified them. Subsequent communication is explicit and symmetric through `message_peer`; sending does not synchronously wait for a reply.

### Current directory contract

Until the follow-up extraction is implemented, automatic spawning distinguishes an explicit cwd from an omitted one:

- An explicit `cwd` must be an existing directory. ClearClaw does not create it and records `owns_worktree: false`. The caller's tooling owns its preparation and cleanup.
- With cwd omitted, a git-backed main gets a standard worktree. ClearClaw records `owns_worktree: true`. The caller may choose a branch; the default is `feat/<name>`.
- With cwd omitted for a non-git main, the peer reuses the main's cwd. No worktree is owned.

An absent ownership field also covers legacy workspaces whose ownership is unknown. A path that resembles a ClearClaw worktree is not evidence of ownership. Rollback and archive remove only worktrees explicitly marked as owned.

Manual `workspace_create` differs from automatic spawning: it can create the requested directory, but it does not create a git worktree. An agent that wants worktree isolation must prepare it before claiming the brief.

### Runtime selection

An automatic peer inherits behavior and compatible runtime settings from its target Project main. If no main resolves for a pending fallback, runtime inheritance uses the caller. Explicit `engine` and `model` arguments take precedence. The effective engine must be registered.

Model choices are passed to the selected engine without an engine-name allowlist. An inherited model survives only when the selected engine matches the inherited engine; changing engines drops that inherited choice. ACP validates an explicit saved choice against the session's advertised configuration when the next turn starts. If no model selector is advertised or the choice is rejected, the turn errors before prompting.

A manual claim chooses its engine in this order:

1. Explicit `workspace_create.engine`.
2. The engine selected for the onboarding task, including native `/engine` selection.
3. The pending spin-out's engine.
4. The server default.

An explicit model wins; otherwise the pending model survives only for a compatible Claude Code engine. This preserves the proposed runtime while allowing the human to change it during setup.

### Platform boundary

Chat IDs are opaque to the orchestrator. Optional methods on `Channel` provide `setupProject`, `createProjectChat`, and `closeProjectChat`. Setup is awaited inline when registering a Project; creation and closure include any platform-specific organization. There is no nested lifecycle object or event hook. Each platform uses a full conversation surface: Telegram topics and Slack channels. Mapping every platform to message threads would weaken the independent-workspace experience.

**Telegram** creates topics within the main's chat. Group Projects require a forum supergroup with Topics enabled and bot permission to manage topics. Private-chat Projects require the bot's Threaded Mode. Topic-qualified IDs keep messages, buttons, typing, files, and status operations in the correct conversation. Group topic teardown closes the topic; private-chat topic teardown deletes it. Closing a whole Telegram chat is unsupported and returns an error. Container readiness is validated immediately before topic creation; startup and archive do not repeat that validation.

**Slack** creates private channels and invites the instance's authorized Slack users. Invite failure attempts to archive the new channel. Teardown archives it. Project grouping is a shared sidebar section backed by a User Group whose members are authorized users and whose initial channel is the Project main. Subsequent lifecycle operations add or remove their own channel without rebuilding membership from config. ClearClaw marks groups it owns and uses a stable hashed handle fallback for collisions; it does not update or disable an unmarked group. Channel creation and shared sections have different permission requirements; [setup documentation](../../README.md#quick-start) describes them.

Sections are Slack-specific and stay inside the Slack adapter. Grouping changes belong to lifecycle operations. Project creation initializes the section and its initial users. Spawning adds only the new channel; archiving removes only the archived workspace's channel, including pre-existing main channels. Spawn rollback also detaches its created chat. Startup and ordinary turns do not synchronize grouping.

Slack reads the live group before each change and sends only the changed channel list. Manual names, handles, members, unrelated channels, and disabled state remain untouched. A missing group is not recreated by peer operations, and an empty group is not automatically disabled. The ownership marker lets a manually renamed group remain identifiable; removing the marker relinquishes that ownership.

Projects whose main is a Slack DM do not initialize a section because the main is not a channel. Their peers remain ungrouped unless an owned section already exists.

Section failures are best-effort and do not fail the peer lifecycle. Removing automatic reconciliation means failed initialization or section edits are not repaired at startup. Section updates use a direct read and write without a queue. Slack's [update API](https://docs.slack.dev/reference/methods/usergroups.update/) replaces the channel list, so overlapping lifecycle operations or manual edits can overwrite each other's grouping changes. We accept this sidebar inconsistency to keep the lifecycle simple; peer creation and operation do not depend on grouping success. Completed manual edits are preserved when read before the update.

### Archive

`workspace_archive` asks for confirmation and refuses to archive the home workspace. It also refuses a Project main while that Project has live peers. Removing the last main removes its Project. Archive closes the bound chat regardless of who created it, then removes the workspace and any emptied Project. If chat closure fails or is unsupported, the workspace stays bound and the tool reports the error. Directory cleanup remains separate: for spawned workspaces, a worktree is removed only when ownership is explicit. External and unknown-ownership directories remain in place.

## Consequences

Peers gain independent sessions and native chats without adding a supervising agent or a platform-specific Project schema. Explicit ownership protects caller-managed directories, while preparation remains a separate responsibility. Model compatibility rules deliberately limit overrides to engines that consume them.

Cleanup is best-effort. Spawn rollback attempts to close and detach a created chat and remove an owned worktree, but it does not undo a workspace record already persisted or a brief already queued. Archive closes the chat before removing config records and attempting owned-directory cleanup. Failures can therefore require manual reconciliation; these operations are not atomic transactions.

Owned-worktree cleanup safely deletes the branch only if git considers it merged. It force-removes the worktree itself, so uncommitted changes can be lost even when unmerged commits remain on a preserved branch. Ownership is not a cleanliness check.

Two additional limits matter when choosing a Project main:

- Telegram creation currently assumes an unqualified main chat ID. Making a main inside an existing topic can produce a four-part ID that sending and closing interpret incorrectly.
- `project_update` checks that a replacement main exists, but does not move workspace membership or reorder grouping. Reassignment requires attention to those separate records.

## Alternatives considered

- Rebuilding the complete section from Project config would make manual platform edits temporary and introduce startup writes. Lifecycle-specific additions and removals preserve user ownership of the section.


- A supervising agent with subordinate workers would centralize work assignment and results. Independent peer workspaces retain direct human steering of each strand.
- A separate spawn-surface registry would add another routing model. A Project's main already supplies the destination and defaults.
- Mapping every peer to a message thread would impose one platform's conversation model on the others. Platform-native topics and channels preserve the workspace experience.
- Adding more repository-specific worktree rules to the relay would expand its filesystem policy. Caller preparation is the chosen follow-up boundary instead.

## Follow-up decision: caller-prepared worktrees

Move worktree preparation out of the `spin_out` tool call. Corporate repositories can require different commands and repository/folder layouts, so coupling those conventions to spawning adds complexity without improving the relay's core job. Agents or caller tooling should prepare the directory using that repository's workflow, then give ClearClaw an existing cwd. ClearClaw retains chat creation, workspace binding, runtime selection, and brief delivery.

This direction is accepted; implementation is tracked in [#46: Move worktree preparation out of spin_out](https://github.com/alleriasun/clearclaw/issues/46). The current built-in worktree behavior above remains until that work lands.

The helper or skill, approval timing for preparation versus spawning, tool-operation granularity, and migration of existing owned worktrees remain design choices for the follow-up. Manual claims must respect the same prepared-directory boundary. Branch names are already caller-selectable, so extraction does not require another naming convention.

Shared-memory capture and injection remain a separate proposal. Editable descriptions provide context without committing the peer lifecycle to a particular memory architecture.

## References

- [Architecture overview and Project model](../ARCHITECTURE.md#workspace-model)
- [Peer-agent backlog](../TASKS.md#peer-agents)
- [Implementation PR](https://github.com/alleriasun/clearclaw/pull/31)
