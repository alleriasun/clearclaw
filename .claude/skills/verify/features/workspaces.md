# Workspaces and projects

From any connected chat, the agent can hand work to a new peer workspace with its own chat, directory, and session (`workspace_create`), message other workspaces, archive them, and group workspaces into Projects. The user confirms creation and archive with buttons. A peer gets its own chat automatically, or the user binds one manually with `/connect <workspace>`. The peer's brief arrives as its first turn.

## Sub-features

- `ws-create-auto`: `workspace_create` posts `Create workspace "<name>" at <cwd> in <project> using <engine>?` with `Create chat` / `Manual chat` / `Cancel`. `Create chat` creates a peer chat, and the brief runs there.
- `ws-create-manual`: `Manual chat` persists the workspace unbound with a pending brief.
- `ws-connect`: `/connect <workspace>` in an unbound chat binds it (`Connected this chat to workspace "<name>".`) and delivers the pending brief.
- `ws-message`: `message_workspace` runs a turn in the target and posts `→ sent to <target>: <summary>` and `← from <source>: <summary>`.
- `ws-archive`: `workspace_archive` asks `Archive workspace "<name>" …?`. Archive closes the chat (`closeProjectChat`) and removes the registration while leaving the directory.
- `ws-project`: `project_create` makes a legacy workspace a Project main, and later peers join that Project by default. `list_workspaces` lists all workspaces.

## How to get to it (user POV)

- Ask the agent in a chat to spin off a peer for some task in a given directory.
- Ask the agent to message, list, or archive another workspace.
- Send `/connect <workspace>` in a new, unbound chat.

## Driving it with ccv

Preconditions:

- A fresh `$V up` (mode `default`). `$V doctor` prints `OK`.
- Make a peer directory: `mkdir -p "$($V where work)/peer"`.

- **Project.** The seeded `proj` has no Project. Without one, `workspace_create` makes each peer the main of a new Project named after the peer. Run `$V send --chat proj "Call project_create with name proj and description 'verification'. Do nothing else."`. `config.json` gains `projects: [{name: "proj", main_workspace: "proj", …}]` and `proj.project: "proj"`.
- **Create (automatic chat).** Run `$V send --chat proj "Call the workspace_create tool with name peer1, cwd $($V where work)/peer, brief 'Reply with exactly: peer ready'. Do nothing else."`. An `interactive` prompt starts `Create workspace "peer1" at …/work/peer in project "proj" using claude-code?`. Run `$V press spawn`. The transcript shows `createProjectChat` with `chat: "term:peer1"`, then the brief turn in `[term:peer1]` with a reply containing `peer ready`. In Telegram mode the chat is a new topic, `tg:-100…:<thread>`, with a `tg action` line `topic created: peer1`. Run `$V wait` if the peer turn is still running. `config.json` lists `peer1` with `chat_id: "term:peer1"` and `project: "proj"`.
- **Talk to the peer.** Run `$V send --chat peer1 "Reply with exactly: hello"`. The turn runs with cwd `work/peer`.
- **Message a workspace.** Run `$V send --chat proj "Call message_workspace with workspace peer1, message 'Reply with exactly: got it', summary 'ping'. Do nothing else."`. Output includes `→ sent to peer1: ping` in `[term:proj]`, `← from proj: ping` in `[term:peer1]`, and a peer turn.
- **Archive.** Run `$V send --chat proj "Call workspace_archive with name peer1. Do nothing else."`, then `$V press yes`. Output: `closeProjectChat [term:peer1]`, plus `tg action` `topic closed` in Telegram mode. `config.json` no longer lists `peer1`, and `work/peer` still exists.
- **Create (manual) and connect.** Repeat the create step with name `peer2`, then run `$V press manual`. No `createProjectChat` appears, and `config.json` shows `peer2` with `chat_id: null` and a `pending_brief`. Run `$V send --chat side "/connect peer2"` (term only: Telegram mode has no unbound chat to send from). The reply is `Connected this chat to workspace "peer2".`, followed by the brief turn in `[term:side]`.
- **Proof.** Cite the `interactive`, `press`, `createProjectChat`/`closeProjectChat`, and peer-turn seq numbers, plus the `config.json` reads before and after.

## Gotchas

- `cwd` must already exist. ClearClaw never creates or deletes it, so the tool refuses a missing path.
- Peer chat IDs come from the `title` argument, slugified. Read the `createProjectChat` line rather than guessing.
- `/connect` refuses an already-bound chat, `default`, or a workspace that already has a chat.
- Archiving a Project main with live peers is refused. Archive the peers first.
- In term mode the harness records the chat calls and pretends they succeeded. Use `--channel telegram` for real forum topics. Slack channels and sidebar sections are not exercised in either mode.
