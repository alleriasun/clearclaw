# Session controls

Native chat commands manage the workspace's session and runtime without calling a model. `/new` starts fresh, `/cancel` stops a running turn, `/recap` replays the current session, `/resume` switches to an earlier session, `/model` and `/engine` change the runtime, and `/behavior` toggles assistant or relay behavior.

## Sub-features

- `sess-new`: `/new` replies `Session cleared.`, clears `current_session_id`, and resets the chat's `/mode`.
- `sess-cancel`: `/cancel` during a turn aborts it and ends with `Turn cancelled.`. With no turn running, it replies `Nothing to cancel.`.
- `sess-recap`: `/recap` replays the user and assistant text of the current session. With no session, it replies `No current session to recap yet.`.
- `sess-resume`: `/resume` lists sessions as buttons under `Pick a session to resume:`. Picking one replies `Resumed session: <summary>`.
- `sess-model`: `/model` shows the saved model. `/model <name>` saves one (`Model set to <name> for the next turn.`), and `/model default` clears it.
- `sess-engine`: `/engine` opens a picker, and `/engine <name>` switches directly (`Engine set to <name>. Session cleared.` plus a handoff note). The next turn carries the previous engine's history.
- `sess-behavior`: `/behavior` offers `Assistant` / `Relay` buttons and saves the choice per workspace.

## How to get to it (user POV)

- Type the command in any bound chat (Slack users type `/cc <command>`, which the harness doesn't model).

## Driving it with ccv

Preconditions:

- A fresh `$V up`. `$V doctor` prints `OK`.
- Steps that need a session run one short turn first: `$V send --chat proj "Reply with exactly: one"`.

- **No-model commands on a fresh chat.** Run `$V send --chat proj /recap`, which replies `No current session to recap yet.`. Run `$V send --chat proj /cancel`, which replies `Nothing to cancel.`. Run `$V send --chat proj /model`, which replies `No model override set. New sessions use the engine's default.`. None of these produce a `typing` line.
- **Recap.** After the precondition turn, run `$V send --chat proj /recap`. The reply contains the user prompt `Reply with exactly: one` and the assistant's `one`.
- **New.** Run `$V send --chat proj /new`. Output: `Session cleared.`, then a `status` line. `"$($V where home)/config.json"` shows `proj.current_session_id: null`.
- **Resume.** Run `$V send --chat proj /resume`. An `interactive` prompt starts `Pick a session to resume:`, and each button value is a session ID. Run `$V press <session-id>`. The reply starts `Resumed session:`, and `config.json` shows that ID as `current_session_id`.
- **Cancel mid-turn.** Run `$V send --chat proj --timeout 5 "Use Bash to run: sleep 60"`. With mode `default` a Bash prompt is pending: run `$V press allow --timeout 5`, then `$V send --chat proj /cancel`. The transcript ends with `Turn cancelled.` and `typing off`.
- **Model.** Run `$V send --chat proj "/model sonnet"`, which replies `Model set to sonnet for the next turn.`. `config.json` shows `proj.model: "sonnet"`. The next turn's `status` names a Sonnet model. Run `/model default`, which replies `Model override cleared. …`.
- **Engine.** Run `$V send --chat proj "/engine codex"`. The reply starts `Engine set to codex.`. The next turn's `status` shows `codex`, and the agent can answer "what did I ask you before?" from the handoff. `/engine` alone opens a picker with one button per engine.
- **Behavior.** Run `$V send --chat proj /behavior`. The prompt reads `Current behavior: relay` with `✓ Relay`. Run `$V press assistant`. `config.json` shows `proj.behavior: "assistant"`.

## Gotchas

- `/resume` is refused while a turn is busy: `A turn is in progress. Wait for it to finish before switching sessions.`.
- `/engine` is refused during a turn: `A turn is running. Use /cancel first, then /engine once it stops.`.
- Engine switching requires that engine in the owner's engine list, which `up` copies. Codex needs the bundled `codex-acp` patch from `npm ci`.
- `/cancel` must be sent while the turn is still running. Use a short `--timeout` on the triggering `send` so you get control back.
- Claude Code lists sessions per cwd, so `/resume` in a fresh scratch `proj` shows only this run's sessions.
