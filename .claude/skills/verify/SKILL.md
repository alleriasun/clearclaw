---
name: verify
description: Drive ClearClaw the way a chat user does and capture proof. Starts an isolated daemon (real Orchestrator, real Claude Code/Codex engines, scratch CLEARCLAW_HOME) behind a recording terminal channel, or the real Telegram adapter on a test bot driven by a second Telegram account. It sends messages, presses permission buttons, and reads back every message, edit, status line, and side effect. Use to verify any change to routing, turns, commands, permissions, workspaces, prompts, or agent tools before reporting it done, or to reproduce a bug before fixing it.
---

# Verify ClearClaw

ClearClaw relays chat (Telegram, Slack) to CLI agents. The harness runs one of two channels behind a recorder that logs every `Channel` call (`src/types.ts`). The default `term` channel is a fake that stands in for the platform adapter. `--channel telegram` uses the real `TelegramChannel` on a dedicated test bot, and a second Telegram account plays the user (see [Telegram mode](#telegram-mode)). Everything behind that boundary is real: `Orchestrator`, config store, prompt assembly, MCP tools, and the engine making real model calls.

## Hard rules

- The owner runs their own daemon on their real bot (`nodemon ... node dist/index.js daemon`). Never stop, restart, or signal it. Never run `npm start`, `npm run dev`, or `node dist/index.js daemon` to verify: they read `~/.clearclaw/config.json` and connect the owner's bot token, and a second poller steals the owner's live messages.
- Never read or write `~/.clearclaw` beyond what `ccv up` does. It copies the `engines` entries and compares, without printing, the production bot token so it can refuse that token in Telegram mode.
- Kill only what `ccv up` started, through `ccv down`. Never `pkill node` or kill by name.

## Launch

```bash
V=.claude/skills/verify/scripts/ccv   # from the repo root; every command below uses $V
[ -d node_modules ] || npm ci
$V up                       # PERMISSION_MODE=default: every tool use asks
$V up --mode bypassPermissions   # or acceptEdits | plan | dontAsk
```

Ready when it prints `up: pid <n>, port <n>, ...` followed by the `home`, `proj`, and `evidence` paths. It fails with a pointer to `daemon.out` if the daemon dies on startup.

Each checkout gets one instance under `/tmp/clearclaw-verify/<checkout>-<hash>/`, so separate worktrees run side by side and a second `up` in the same checkout refuses. `up` seeds a fresh state every time:

- `home/`: the scratch `CLEARCLAW_HOME` with an authorized user `term:owner` and the owner's engine list (same CLI paths and settings files, so the default engine and model match production).
- Chat `dm`: the owner's root DM. The first message binds it to the home workspace (`default`, assistant behavior, 1 s debounce). Assistant behavior runs tools under `bypassPermissions` and hides 🔧 lines, so no permission prompts appear there until you send `/mode` and press `default`.
- Chat `proj`: a workspace named `proj`, bound to `term:proj`, cwd `work/proj/` (contains one `README.md`, relay behavior, no Project).

The daemon loads `src/` once at startup. After editing `src/`, run `$V down && $V up`. `prompts/` and `home/workspace/instructions/` are read every turn.

## Doctor

```bash
$V doctor
```

Read-only. Prints the state and health JSON, then `OK` or `NOT OK` followed by the problems: process gone, control port answering as another pid, wrong `CLEARCLAW_HOME`, HEAD moved, or `src/` or the harness scripts changed since `up` (by content, so a file restored to HEAD still counts). Run it first whenever output looks wrong, and before trusting a result after you edited code.

## Drive

```bash
$V send "what's in this directory?"              # home DM (chat dm)
$V send --chat proj "Use the Write tool to create a.txt containing x"
$V press allow                                   # value or label of a button on the pending prompt
$V press deny --text "use b.txt instead"         # Deny + Note: the note goes back to the agent
$V wait                                          # keep watching after a timeout
$V log                                           # whole transcript; --json for raw entries
$V where proj                                    # absolute path of a run dir: root|home|work|proj|evidence
```

- `send`, `press`, and `wait` block until the chat **settles**, then print what happened since the action. Settled means a button prompt is waiting with 1 s of quiet, or no chat is typing and nothing was sent for 3 s since the action. `--timeout <s>` (default 300) bounds the wait. On timeout the output ends with `-- TIMED OUT`, and the turn may still be running. Settling infers completion from typing and quiet, so a native command that does slow work without typing (`/recap` on a long session) or a turn after `stay_silent` can settle early; run `$V wait` (or `$V log`) before concluding nothing more arrived.
- Output lines are `#<seq> >> <op>` for what the user did, `#<seq> << <op> [chat] {fields}` for what ClearClaw asked the channel to do, and `#<seq> tg <op>` for what the Telegram test user actually received (Telegram mode only). Message text is indented below. `>> answered` records the value the channel delivered back for a prompt. Ops: `send`, `edit` (same `handle` as the message it rewrites), `delete`, `pin`, `unpinAll`, `status` (the pinned status line), `typing`, `interactive` (buttons), `file`, `react`, `createProjectChat`, `closeProjectChat`, `groupProjectChat`.
- A pending prompt prints `-- waiting on prompt m<n>`. While it waits, that chat's turn is blocked. With several pending prompts, pass `--id m<n>`.
- Slash text goes through the same path as typed text: `/new`, `/mode`, `/cancel`, and others are handled natively. Unknown slash commands pass through to the engine.
- `--chat dm` is the user's root DM. Any other `--chat <name>` is that workspace's chat, read from `home/config.json`, so a peer created by `workspace_create` is addressable by its workspace name (`--chat peer1`) once it exists. In term mode a name with no workspace becomes `term:<name>`, which is how you reach a fresh unbound chat for `/connect`. A term peer chat gets id `term:<slugified title>`.
- Every model turn spends the owner's real quota on their default model. Keep prompts short and literal ("Use the Write tool to …, do nothing else"). Run `/model <name>` in the chat when the model choice doesn't matter for the claim.

## Telegram mode

The real `TelegramChannel` (grammY long polling, MarkdownV2 rendering, inline keyboards, force-reply follow-ups, pins) on a dedicated test bot. The user is a second Telegram account, driven through MTProto (gramjs), so its messages and button taps reach the bot exactly as a phone's would. Use it for changes to `src/channel/telegram.ts`, Telegram formatting, button flows, or anything where "Telegram accepted and showed it" is the claim.

One-time setup by the owner, in a terminal, because it needs a login code:

```bash
.claude/skills/verify/scripts/ccv telegram-setup
```

It asks for the api_id and api_hash (my.telegram.org, as the test account), the test bot token (@BotFather), the test account's phone, the login code, and the 2FA password if set. It writes `~/.config/clearclaw-verify/telegram.json` (0600). If that file is missing, stop and ask the owner to run setup. Don't try to log in yourself.

```bash
$V up --channel telegram          # refuses the production bot token; takes the test-bot lock
$V doctor                         # also checks the lock, the user client, and the test group
$V send "Reply with exactly: pong"
$V send --chat proj /new          # the group root
$V press allow                    # taps the real inline button; --text also answers "Add your feedback:"
$V down                           # stops the daemon, disconnects the client, releases the lock
```

- Chats match production. `dm` is the test account's DM with the test bot, bound to home, so permission prompts there need `/mode` then `press default` first (see the `dm` bullet under Launch). `proj` is bound to the root of a forum supergroup, `tg:-100…`. Peers that `workspace_create` spawns become topics in that group, `tg:-100…:<thread>`, and you address them by workspace name. A name with no workspace chat is an error that lists the known ones.
- The test group belongs to the test account, and the test bot is an admin there (topics, pins, deletes, info). `up` creates it on first use and records its ids in `~/.config/clearclaw-verify/telegram-group.json`. Later runs check that it still exists, is a forum, and that the bot keeps its rights. `up` repairs what it can and recreates the group if it is gone.
- The test account posts into a topic as a reply to the topic's root, the way Telegram clients do. `send` returns only after the bot emits the message with the expected chat id, so a routing mismatch fails as a 15 s timeout.
- `down` deletes the topics this run created, found through `createProjectChat` and `topic created` entries in the transcript. It keeps the group and its General topic.
- The test bot is one poller across all checkouts. `/tmp/clearclaw-verify/telegram.lock` holds the owning pid, and `up` refuses while another checkout holds it. `up` also drops updates queued since the last run.
- `tg` entries carry `chat` (root, or `:<thread>` for a topic), `msgId`, raw `text`, compact `entities` (`bold@0+5`), and `buttons` rows. Compare them with the matching `<<` lines. `tg action` records a service message from the bot in the group, such as `topic created: peer1` or `topic closed`. If a reply that should be formatted arrives with no entities, look in `daemon.out` for `sendMessage failed with MarkdownV2, retrying as plain text`.
- Telegram rate limits apply. Keep runs short and don't loop sends.

## Evidence

Everything lands in the `evidence/<timestamp>/` path that `up` printed and survives `down`:

- `transcript.jsonl`: every inbound action and outbound channel call, timestamped and in order. This is the primary proof.
- `daemon.out`: the daemon's stdout and stderr (pino-pretty logs, crashes).
- `clearclaw.<n>.log`: the daemon's own log, copied in by `down`.
- `files/`: anything the agent sent with `send_file`.

Proof standards:

- Drive the user path: `send` and `press`. Don't call orchestrator methods, edit `home/config.json` by hand mid-run, or add test-only routes.
- Show the action and its result: the `>> message` or `>> press` line, then the `<<` lines that answer it. Quote transcript seq numbers in the report.
- Check side effects with a second, independent read: `cat "$($V where proj)/<file>"` for files the agent wrote, read `"$($V where home)/config.json"` for workspace or session changes, and check `git` state when the claim involves it. Do all of this before `down`, because `down` deletes `home/` and `work/`.
- A claim about a specific feature needs every entry point in its [feature map](features/README.md) file, or an explicit list of the ones you skipped.

## Cleanup

```bash
$V down   # SIGTERM our pid (SIGKILL after 10 s), copy logs to evidence, delete home/ work/ state.json
```

Run `down` after every run, including failed ones. `up` refuses while a stale instance is alive. Evidence directories accumulate under `/tmp/clearclaw-verify/<checkout>/evidence/`, and you may delete old ones.

## What this does not cover

- **Slack, and Telegram DM topics:** `src/channel/slack.ts` has no live mode. Telegram DM Threaded Mode (topics inside a DM) is not driven, because production uses forum groups. Cover those with `test/slack.test.ts` and `test/telegram.test.ts`, then tell the owner that live-platform proof is still missing. Never borrow the owner's bot token for it.
- **Pixels:** Telegram mode proves what Telegram stored (text, entities, buttons), not how a client draws it.
- **Inbound features:** attachments, reply-to context, unauthorized users and pairing, multiple senders. Neither mode sends these yet.
- **Scheduler firing:** schedules fire on wall-clock cron. `wait` returns after 3 s of quiet, so for a one-off ISO timestamp a minute out, `sleep` until just past it, then `$V wait`.

## Pairing with tests

Run `npm run check` (tsc) and `npm test` (`node:test` over `test/*.test.ts`) for unit-level proof. For TDD, write the failing test in `test/` first. Then use `ccv` to prove the fix through a real turn, because a passing test alone shows the unit works, not that the user-visible behavior changed.

## Helpers

- `scripts/ccv`: bash entry point (needs `node_modules`). Run `$V help` for usage.
- `scripts/harness.ts`: the client commands, the `serve` daemon (Orchestrator, a `Driver` per channel kind, and the recording proxy), and the loopback control API (`/send`, `/press`, `/wait`, `/log`, `/health`).
- `scripts/telegram.ts`: the secrets file, the test-bot lock, the Telegram driver (gramjs user client), and `telegram-setup`.

`npm run check` does not cover these files, and tsx runs it without type checking. After changing `src/types.ts` or the harness, run this check (it follows the import into `telegram.ts`), then extend `TermChannel` and the recorder if `Channel` gained a method:

```bash
npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck --types node .claude/skills/verify/scripts/harness.ts
```
