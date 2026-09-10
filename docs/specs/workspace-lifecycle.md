# Workspace lifecycle

## Status

Accepted. Supersedes the conversational onboarding and task-session portions of the dated onboarding specs. Pairing remains the authorization mechanism. Scheduling remains independent.

## Context

Successful spin-outs already created their workspace, chat, and first conversation without an onboarding interview. The separate setup session duplicated creation logic and restricted `workspace_create` to unbound chats. Creating an independent project from an existing conversation required spawning into the wrong project and adopting it afterward.

## Decision

### Home and authorization

The service ensures the home directory, `default` workspace, and its project exist before starting channel routing. New home workspaces use assistant behavior and inherit the configured default engine. Existing directories, identity files, runtime choices, bindings, and project metadata are preserved. A workspace can have `chat_id: null` before its destination is known.

The platform supplies user and chat IDs on incoming messages. Setup or `approve` consumes a pairing code, authorizes the user, and binds an unbound home to that approved root DM. Environment-based and previously approved installations can bind through their first authorized root DM. Groups, Telegram topics, unauthorized users, and chats already assigned to another workspace cannot claim home. A later approval never replaces an existing home binding.

### Creation from ordinary conversations

`workspace_create` is the single creation operation, available in every connected workspace conversation. It creates the workspace, its chat, and its first conversation in one call. Membership defaults to the caller's own project; `join_project` names a different existing one, and `own_project` starts a new project with this peer as its main. Unknown projects are errors, not implicit project creation.

`cwd` and `brief` are both required. The caller prepares the directory using whatever this host and repository expect and keeps owning it; ClearClaw only reads the path. Requiring a brief means a new peer always wakes with its goal, decisions, and scope rather than an empty conversation.

Automatic creation requests the platform chat, registers the workspace/project, initializes optional platform grouping, and queues any brief into a fresh workspace session. Standalone projects use the source workspace's chat as their initial platform container and inherit its runtime unless overridden. Peers inherit from their project's main. Telegram topic anchors are normalized to the parent chat before forming the new topic ID.

Creation reserves the workspace name within the process, rechecks config after awaiting the platform, and rolls back newly created records and chats on failure before completion. Notification failures after registration do not undo a created workspace. Directories are never created or removed.

### Manual connection and first brief

Manual creation persists the workspace with a null chat ID and optional brief. The user sends `/connect <workspace>` in the intended unbound chat, or `/cc connect <workspace>` in Slack. This native command requires an authorized sender and refuses to replace either an existing chat binding or a workspace destination. Home uses DM pairing instead.

Unbound chats receive connection instructions without invoking a model. They do not borrow home's session. A connected workspace uses normal session storage and engine controls immediately; there is no `TaskState`, onboarding prompt, or `task_complete` tool.

The optional `pending_brief` persists its source and text until a successful non-aborted ordinary turn. Startup queues saved briefs for bound workspaces. Failed/cancelled turns retain the brief, and the next ordinary turn includes it again. Pass-through slash commands leave it pending. This provides retry across failures and restarts, not exactly-once external side effects; an interrupted engine may have performed some work before retry.

### Project membership

`project_create` can adopt a peer into a new project. It refuses any workspace referenced as a project's main, including inconsistent legacy records. `project_update` can reassign a main only to a workspace already belonging to that project. Creating a new standalone workspace no longer requires adoption.

### Scheduling

Schedules remain stored prompts with independent timers. Enabled schedules start with the service and inject into `default` using its current session and normal queue. A bound home is required for delivery. There is no scheduling dependency on the retired task-session machinery, and per-workspace schedule targeting is outside this change.

## Consequences

One workspace creation implementation serves both new projects and related peers. Home is available by default, and pairing supplies its chat destination without a questionnaire or environment-ID copying. Manual groups need a native connection command after creation from an existing workspace. Learning personal preferences happens during ordinary conversation.

Existing sessions and configuration remain usable. This change does not restart the running relay or archive existing workspaces. Legacy pending spin-out records are dropped; none existed. Existing platform permissions still apply to automatic creation.

## Alternatives

- A temporary agent in every unbound chat would recreate a second session lifecycle and require a separate policy for private home context. A native connection command keeps binding explicit.
- Keeping `spin_out` as a second tool alongside `workspace_create` would preserve two nearly identical handlers over one shared implementation, for a difference that is three argument defaults.
- Leaving `cwd` optional would keep repository-specific worktree conventions inside the relay, which is the boundary [#46](https://github.com/alleriasun/clearclaw/issues/46) moved out.
- Routing all unbound chats through home's session would mix conversations and expose context across chats.
