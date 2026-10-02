# ClearClaw verification map

This directory is the maintained source for verifying ClearClaw's user-facing behavior. Read this index before driving, then use the matching feature file as the recipe. Every command is `$V <cmd>`, where `V=.claude/skills/verify/scripts/ccv` is run from the repo root (see [SKILL.md](../SKILL.md)).

## Baseline preconditions

- `npm ci` has run in this checkout.
- Run `$V up` to get a fresh instance. Add `--mode <permission mode>` only when the recipe asks for it.
- `$V doctor` prints `OK`.
- Chat `dm` is the owner's root DM and binds to home (`default`) on its first message. Chat `proj` is bound to workspace `proj` (cwd `work/proj/`, relay behavior). `--chat <workspace>` addresses any workspace with a chat, including peers once created.
- Drive only an instance this run started. The owner's own daemon is never a target.

## Driving conventions

- Start every recipe from a fresh `up` unless it says it continues another recipe.
- Treat quoted messages as literal. Model prompts name the exact tool and add "do nothing else", so the expected transcript stays small.
- Match ClearClaw's own strings exactly, such as `Session cleared.` or `🔐 Allow Write?`. Model replies vary, so assert their effect, not their wording.
- Press buttons by `value`. When two buttons share a value (`Deny` and `📝 Deny + Note`), `--text` selects the one that asks for text.
- Run independent side-effect checks before `$V down`, which deletes `home/` and `work/`.
- Recipes are written for the default `term` channel. With `--channel telegram`, `proj` is a forum supergroup root and peers are its topics. Chat ids read `tg:-100…` and `tg:-100…:<thread>` instead of `term:<name>`, and each `<<` line should have a matching `tg` line showing what the test user received. Steps that need an unbound chat (`/connect` in a new chat) apply only to term.

## Proof and skip reporting

- Cite transcript seq numbers for the user action (`>>`) and ClearClaw's response (`<<`).
- Mutation proof includes a second read that doesn't go through the chat: the file on disk, or `home/config.json` for workspaces, sessions, models, behavior, and schedules.
- Report the evidence directory path printed by `up`. It survives `down`.
- Report an unreachable entry point with the command you tried and the precondition that failed. Don't report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with ccv` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Chat turns](./chat-turn.md) covers home and project messages, streamed replies, the rolling tool line, the status line, and pass-through slash commands.
- [Permission relay](./permission-relay.md) covers Allow, Deny, Deny + Note, `/mode`, the startup permission mode, plan approval, and AskUserQuestion.
- [Session controls](./session-controls.md) covers `/new`, `/cancel`, `/recap`, `/resume`, `/model`, `/engine`, and `/behavior`.
- [Workspaces and projects](./workspaces.md) covers `workspace_create` (automatic and manual chat), `/connect`, `message_workspace`, `workspace_archive`, and `project_create`.
- [Agent chat tools](./agent-tools.md) covers `send_file`, `react`, `reply_to`, `stay_silent`, and `schedule_*`.
