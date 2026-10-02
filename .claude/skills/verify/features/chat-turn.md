# Chat turns

The user sends a message in a bound chat. ClearClaw shows typing, runs one engine turn in that workspace's directory and session, and streams the agent's text back as a message it keeps editing. Tool use collapses into one rolling `🔧` line, which becomes a per-tool summary when the turn ends. A status line follows with the model, context use, engine, and plan quota. Home (the owner's DM) batches rapid messages and uses assistant tools. Project chats relay each message immediately.

## Sub-features

- `turn-home`: a DM message runs in home (`default`) after a 1 s debounce. The first DM binds home to the chat.
- `turn-project`: a project chat message runs at once, in that workspace's cwd.
- `turn-stream`: long replies arrive as a `send` followed by `edit`s of the same handle.
- `turn-tools`: tool calls show as one `🔧 <Tool>: …` line, edited to `🔧 <n>× <Tool>, …` at the end.
- `turn-status`: a `status` line follows each turn: `🤖 <model> <pct>% | <engine> | <quota>`.
- `turn-queue`: messages sent while a turn runs queue behind it.
- `turn-passthrough`: unknown slash commands reach the engine verbatim.
- `turn-unbound`: a message in an unbound chat gets connection guidance without running a model.
- `turn-missing-cwd`: a workspace whose cwd is missing refuses with `⚠️ Can't start: this workspace's directory doesn't exist:`.

## How to get to it (user POV)

- DM the bot (home).
- Post in a chat bound to a project workspace.
- Type a slash command ClearClaw doesn't own (for example a Claude Code skill or command).
- Post in a chat that isn't bound to any workspace.

## Driving it with ccv

Preconditions:

- A fresh `$V up`. `$V doctor` prints `OK`.

- **Home turn.** Run `$V send "Reply with exactly: pong"`. Output: `>> message [term:dm]`, `<< typing on`, a `<< send` with `pong`, `<< status`, `<< typing off`. Afterwards `"$($V where home)/config.json"` shows workspace `default` with `chat_id: "term:dm"` and a non-null `current_session_id`.
- **Project turn with a tool.** Run `$V send --chat proj "Use the Read tool on README.md and reply with its first line only."`. If a prompt appears, run `$V press allow`. The output has `🔧 Read: …`, then an `edit` of that handle to `🔧 1× Read`, then a reply containing `# proj`.
- **Session continuity.** Run `$V send --chat proj "What file did you just read? One word."`. The reply names `README.md`, so the turn resumed the stored session.
- **Pass-through.** Run `$V send --chat proj /context` (any engine-owned command works). ClearClaw sends no native reply such as `Session cleared.`. A turn runs, and the engine's response arrives as a `send`.
- **Unbound chat.** Run `$V send --chat nowhere "hi"`. One `<< send` reads `No workspace linked to this chat. Create a workspace with a manual chat from home or another workspace, then send /connect <workspace> here.` No `typing` line appears.
- **Missing cwd.** Delete the proj directory with `rm -rf "$($V where proj)"`, then run `$V send --chat proj "hi"`. The reply starts with `⚠️ Can't start: this workspace's directory doesn't exist:`.
- **Proof.** Cite the seq numbers of the message, the reply, and the status line. Include the `config.json` session read.

## Gotchas

- Home debounces for 1 s, and `send` waits for a quiet chat. Two `send`s in a row are two turns, not one batch. Batching can't be driven yet.
- Streaming edits only appear for replies long enough to cross the edit thresholds. Short answers are a single `send`.
- The status line is skipped when its text is unchanged since the last turn.
- Home runs under `bypassPermissions` and shows no 🔧 line. Assert tool use by its side effect, or use `proj`.
- Home sees assistant-only tools (`stay_silent`, `react`, `reply_to`). Project chats don't, unless `/behavior` switches them.
