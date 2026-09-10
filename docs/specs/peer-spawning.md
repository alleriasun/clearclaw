# Decision: Projects and peer spawning

## Status

Accepted for the peer lifecycle, including caller-prepared working directories.

This record preserves the architectural choices and their consequences. Update its status or supersede the decision when those choices change; execution plans and verification logs belong outside the spec.

## Context

Related work often needs a separate conversation and working directory. A peer is an ongoing workspace the human can steer directly, with its own engine session. It receives a distilled brief and can communicate with existing workspaces through `message_workspace`, in any project.

ClearClaw supplies transport and lifecycle operations. The human and agents decide what work belongs together. A peer is not a subordinate agent whose result must return to a supervisor, and spawning does not introduce an agent that plans or assigns everyone's work. Workspace chats provide separate contexts without requiring a separate bot identity for every agent.

A new strand normally gets a new workspace; a true continuation can use an existing peer. Working-directory isolation and workspace lifetime are independent choices. A long-lived worktree is valid, and a non-git workspace can share a directory when that is intended.

## Decision

### Model

A **Workspace** binds a unique name, working directory, optional chat, and current engine session. A null chat waits for pairing or manual connection. Its optional `project` identifies the Project it belongs to. `engine`, `model`, and `behavior` control its runtime. `description` records what it is working on.

A **Project** has a unique name, a description, and a `main_workspace`. It holds shared context and identifies the spawning baseline; it has no engine session. Project names need not match workspace names.

The **main workspace** supplies the Project's spawn destination, directory baseline, and default runtime. Spawned **peers** join that Project and record their originating workspace in `spawnedFrom`. Chat closure does not depend on that provenance.

`workspace_create` creates a new Project and its main workspace together from any connected workspace conversation, or joins an existing Project when explicitly requested. `project_create` wraps an existing workspace, including adopting a peer out of another Project; it refuses any workspace referenced as a Project main. See [Workspace lifecycle](workspace-lifecycle.md) for startup, pairing, and manual binding.

`Project.description` and `Workspace.description` are editable context. A peer has a separate one-line description; if omitted, it defaults to the first 160 characters of the brief’s first line. These fields are stored but are not currently injected into prompts as shared project memory.

### Proposal and handoff

`workspace_create` is the single creation operation. It targets the Project named by `project`, otherwise the caller's own. A name that matches no existing Project creates it, with the new workspace as its main; the confirmation distinguishes joining a Project from creating one. It resolves the Project main and runtime before proposing the handoff. The main chat is the spawn destination; there is no separate spawn-surface registry or global catch-all.

When the Project, main workspace, and channel's Project lifecycle capability are available, the user chooses **Create chat**, **Manual chat**, or **Cancel**. Automatic creation makes the platform chat with its lifecycle grouping update, persists the workspace, and queues the brief as a peer message.

Missing Projects or mains are errors. When automatic creation is unavailable, the user can choose a manual workspace. A failed automatic attempt reports the platform error without silently creating another registration.

Manual creation saves a workspace with a null chat ID and a persisted first brief. The user connects it through `/connect <workspace>` (Slack: `/cc connect <workspace>`) in an authorized unbound chat. The brief runs in the normal workspace session and is retained until a successful non-aborted turn. New manual workspaces keep their intended Project membership.

The brief conveys the goal, decisions the human has already made, and scope. Implementation choices stay with the receiving workspace unless the human has specified them. Subsequent communication is explicit and symmetric through `message_workspace`; sending does not synchronously wait for a reply. `list_workspaces` supplies the names, scoped to a Project or across all of them.

### Directory contract

`cwd` is required and must already exist as an absolute path. ClearClaw reads it and nothing more: it never creates, moves, or deletes a workspace directory, on creation, rollback, or archive.

The caller prepares the directory using whatever its repository expects, whether a git worktree, a clone, or a plain folder, and keeps owning its cleanup. A path that resembles a ClearClaw worktree carries no special meaning.

### Runtime selection

An automatic peer inherits behavior and compatible runtime settings from its target Project main. Standalone workspace creation inherits from the caller. Explicit `engine` and `model` arguments take precedence. The effective engine must be registered.

Model choices are passed to the selected engine without an engine-name allowlist. An inherited model survives only when the selected engine matches the inherited engine; changing engines drops that inherited choice. ACP validates an explicit saved choice against the session's advertised configuration when the next turn starts. If no model selector is advertised or the choice is rejected, the turn errors before prompting.

Manual workspaces retain the selected runtime. Legacy pending claims use an explicit engine/model first, otherwise their saved engine and compatible model, with server defaults for absent choices. There is no onboarding engine selection state.

### Platform boundary

Chat IDs are opaque to the orchestrator. Optional methods on `Channel` provide `setupProject`, `createProjectChat`, and `closeProjectChat`. Setup is awaited inline when registering a Project; creation and closure include any platform-specific organization. There is no nested lifecycle object or event hook. Each platform uses a full conversation surface: Telegram topics and Slack channels. Mapping every platform to message threads would weaken the independent-workspace experience.

**Telegram** creates topics within the main's chat. Group Projects require a forum supergroup with Topics enabled and bot permission to manage topics. Private-chat Projects require the bot's Threaded Mode. Topic-qualified IDs keep messages, buttons, typing, files, and status operations in the correct conversation. Group topic teardown closes the topic; private-chat topic teardown deletes it. Closing a whole Telegram chat is unsupported and returns an error. Container readiness is validated immediately before topic creation; startup and archive do not repeat that validation.

**Slack** creates private channels and invites the instance's authorized Slack users. Invite failure attempts to archive the new channel. Teardown archives it. Project grouping is a shared sidebar section backed by a User Group whose members are authorized users and whose initial channel is the Project main. Subsequent lifecycle operations add or remove their own channel without rebuilding membership from config. ClearClaw marks groups it owns and uses a stable hashed handle fallback for collisions; it does not update or disable an unmarked group. Channel creation and shared sections have different permission requirements; [setup documentation](../../README.md#quick-start) describes them.

Sections are Slack-specific and stay inside the Slack adapter. Grouping changes belong to lifecycle operations. Project creation initializes the section and its initial users. Spawning adds only the new channel; archiving removes only the archived workspace's channel, including pre-existing main channels. Spawn rollback also detaches its created chat. Startup and ordinary turns do not synchronize grouping.

Slack reads the live group before each change and sends only the changed channel list. Manual names, handles, members, unrelated channels, and disabled state remain untouched. A missing group is not recreated by peer operations, and an empty group is not automatically disabled. The ownership marker lets a manually renamed group remain identifiable; removing the marker relinquishes that ownership.

Projects whose main is a Slack DM do not initialize a section because the main is not a channel. Their peers remain ungrouped unless an owned section already exists.

Section failures are best-effort and do not fail the peer lifecycle. Removing automatic reconciliation means failed initialization or section edits are not repaired at startup. Section updates use a direct read and write without a queue. Slack's [update API](https://docs.slack.dev/reference/methods/usergroups.update/) replaces the channel list, so overlapping lifecycle operations or manual edits can overwrite each other's grouping changes. We accept this sidebar inconsistency to keep the lifecycle simple; peer creation and operation do not depend on grouping success. Completed manual edits are preserved when read before the update.

### Archive

`workspace_archive` asks for confirmation and refuses to archive the home workspace. It also refuses a Project main while that Project has live peers. Removing the last main removes its Project. Archive closes the bound chat regardless of who created it, then removes the workspace and any emptied Project. A same-channel closure failure is reported while registration cleanup continues. Cross-channel or missing-capability targets remain protected. An unbound workspace has no chat to close. Directory cleanup remains the caller's: archive always leaves the directory on disk and says so.

## Consequences

Peers gain independent sessions and native chats without adding a supervising agent or a platform-specific Project schema. Explicit ownership protects caller-managed directories, while preparation remains a separate responsibility. Model compatibility rules deliberately limit overrides to engines that consume them.

Cleanup is best-effort. Spawn rollback attempts to close and detach a created chat, and removes any records persisted by the failed creation. It never touches the directory. Once creation has committed, notification failures do not roll back the workspace or its brief. A created chat subsequently bound to another workspace is preserved during rollback. Archive closes the chat before removing config records. Failures can therefore require manual reconciliation; these operations are not atomic transactions.

Two additional limits matter when choosing a Project main:

- Telegram Projects created from another topic use the same root chat as their platform container.
- `project_update` requires the replacement main to belong to that Project. Reassignment does not reorder platform grouping.

## Alternatives considered

- Rebuilding the complete section from Project config would make manual platform edits temporary and introduce startup writes. Lifecycle-specific additions and removals preserve user ownership of the section.


- A supervising agent with subordinate workers would centralize work assignment and results. Independent peer workspaces retain direct human steering of each strand.
- A separate spawn-surface registry would add another routing model. A Project's main already supplies the destination and defaults.
- Mapping every peer to a message thread would impose one platform's conversation model on the others. Platform-native topics and channels preserve the workspace experience.
- Adding repository-specific worktree rules to the relay would expand its filesystem policy. Caller preparation is the chosen boundary instead.

## Decision: caller-prepared worktrees

Worktree preparation is out of the creation tool. Corporate repositories can require different commands and repository/folder layouts, so coupling those conventions to spawning added complexity without improving the relay's core job. Agents or caller tooling prepare the directory using that repository's workflow, then give ClearClaw an existing cwd. ClearClaw retains chat creation, workspace binding, runtime selection, and brief delivery.

Implemented; this closes [#46](https://github.com/alleriasun/clearclaw/issues/46).

The helper or skill, approval timing for preparation versus spawning, tool-operation granularity, and migration of existing owned worktrees remain design choices for the follow-up. Manual claims must respect the same prepared-directory boundary. Branch names are already caller-selectable, so extraction does not require another naming convention.

Shared-memory capture and injection remain a separate proposal. Editable descriptions provide context without committing the peer lifecycle to a particular memory architecture.

## References

- [Architecture overview and Project model](../ARCHITECTURE.md#workspace-model)
- [Peer-agent backlog](../TASKS.md#peer-agents)
- [Implementation PR](https://github.com/alleriasun/clearclaw/pull/31)
