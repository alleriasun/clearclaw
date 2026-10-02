# Agent chat tools

ClearClaw gives the agent MCP tools (`mcp__clearclaw__*`) that act on the chat itself, and they never prompt for permission. Any chat gets `send_file` and the `schedule_*` tools. Assistant-behavior chats (home by default) also get `react`, `reply_to`, and `stay_silent`.

## Sub-features

- `tool-file`: `send_file` posts a file or image with an optional caption.
- `tool-react`: `react` puts an emoji on a user message identified by its `[msg:N]` tag.
- `tool-reply`: `reply_to` threads the turn's text reply to a user message.
- `tool-silent`: `stay_silent` ends the turn with no text reply and stops typing.
- `tool-schedule`: `schedule_create`/`list`/`delete`/`toggle` manage prompts that fire into home on a cron or a one-off ISO time.

## How to get to it (user POV)

- Ask the agent to send a file, react to a message, reply to a specific message, or stay quiet.
- Ask the agent to remind you of something later, or to do something on a schedule.

## Driving it with ccv

Preconditions:

- A fresh `$V up`. `$V doctor` prints `OK`.
- Use chat `dm` (home, assistant behavior) for `react`, `reply_to`, and `stay_silent`.

- **Send file.** Run `$V send --chat proj "Call the send_file tool with file_path $($V where proj)/README.md and caption 'readme'. Do nothing else."`. Output: `<< file [term:proj] {"filename":"README.md","bytes":<n>,"saved":"…/evidence/…/files/<seq>-README.md","opts":{"caption":"readme"}}`. The saved file matches `README.md` byte for byte (`cmp`).
- **React.** Run `$V send "React to this message with 👍 using the react tool and stay silent."`. Output: `<< react [term:dm] {"messageId":"u<n>","emoji":"👍"}`, where `u<n>` matches the `>> message` you sent, and no text `send` follows.
- **Reply to.** Run `$V send "Use reply_to on this message, then reply: threaded"`. The reply `send` carries `opts.replyToMessageId` equal to your message's id.
- **Stay silent.** Run `$V send "Call stay_silent. Do not reply."`. No `<< send` follows, and `typing` turns off.
- **Schedule.** Run `$V send "Call schedule_create with cron set to an ISO timestamp 60 seconds from now (check the time first) and prompt 'Reply with exactly: tick'."`. `config.json` gains a `schedules` entry; note its time. `wait` returns after 3 s of quiet, so `sleep` until about 10 s after that time, then run `$V wait`. `$V log` shows a scheduler-originated home turn (no `>> message` line before it) that replies `tick`, and the one-off entry is gone from `config.json`.
- **Proof.** Cite the tool-effect lines (`file`, `react`, a reply with `replyToMessageId`), the `files/` artifact, and the `config.json` schedule reads.

## Gotchas

- The harness stamps user messages `u<seq>`. Assistant chats see them as `[msg:u<seq>]` tags, which `react` and `reply_to` need.
- `react`, `reply_to`, and `stay_silent` don't exist in relay chats such as `proj`. The agent will say it lacks the tool.
- Schedules only deliver when home is bound. Send one `dm` message first on a fresh instance.
- Timezone defaults to the host's. A naive ISO timestamp is read in host local time.
