# Permission relay

When the agent wants to use a tool that needs approval, ClearClaw posts a `🔐 Allow <Tool>?` prompt with a preview: a diff or file content for Edit and Write, and the command, pattern, or URL for other tools. The user answers Allow, Deny, or Deny + Note, and the answer decides whether the tool runs. Claude Code's own interactive tools (plan approval, AskUserQuestion) use the same channel with their own buttons.

## Sub-features

- `perm-allow`: Allow runs the tool, and its effect is visible on disk.
- `perm-deny`: Deny blocks the tool, so nothing changes on disk.
- `perm-note`: Deny + Note blocks the tool and returns the note to the agent, which adjusts its next step.
- `perm-mode-cmd`: `/mode` switches this chat's permission mode mid-session. The status line shows `🔒 <Mode>` when the mode differs from the startup mode.
- `perm-mode-startup`: the daemon's `PERMISSION_MODE` (`up --mode`) sets the default. `bypassPermissions` runs tools without prompts.
- `perm-plan`: ExitPlanMode posts the plan with `👍 Approve` / `👎 Reject` / `📝 Reject + Note`.
- `perm-ask`: AskUserQuestion posts one button per option plus `Other…`, which takes free text.
- `perm-own-tools`: ClearClaw's own `mcp__clearclaw__*` tools never prompt.

## How to get to it (user POV)

- Ask the agent for something that uses a gated tool (Write, Edit, Bash) in any chat while the mode is `default`.
- Send `/mode` in the chat and pick a mode.
- Start the daemon with a non-default `PERMISSION_MODE`.
- Ask for a plan while in Plan mode, or ask the agent to ask you a multiple-choice question.

## Driving it with ccv

Preconditions:

- A fresh `$V up` (mode `default`). `$V doctor` prints `OK`.
- `work/proj/` contains only `README.md`.

- **Prompt appears.** Ask for a write. Run `$V send --chat proj "Use the Write tool to create hello.txt in the current directory containing exactly: hi from ccv. Do nothing else."`. The output contains a `<< send` line starting `🔧 Write:`, then `<< interactive` with text `🔐 Allow Write?`, the full path, a code block containing `hi from ccv`, buttons `allow` / `deny` / `deny`(requestText), and `-- waiting on prompt m<n>`.
- **Allow.** Run `$V press allow`. The output shows `>> press {"value":"allow"}`, a `<< send` reply from the agent, an `<< edit` of the 🔧 line to `🔧 1× Write`, a `<< status` line such as `🤖 <model> <n>% | claude-code | …`, and `typing {"on":false}`. `cat "$($V where proj)/hello.txt"` prints `hi from ccv`.
- **Deny.** Ask for a second write (`b.txt`) and run `$V press deny`. `b.txt` does not exist in `work/proj/`.
- **Deny + Note.** Ask for `c.txt` and run `$V press deny --text "name it d.txt instead"`. The `>> press` line carries the note. A new `🔐 Allow Write?` prompt names `d.txt`, or the agent's reply cites the note. `c.txt` does not exist.
- **Mode command.** Run `$V send --chat proj /mode`. An `<< interactive` prompt reads `Current mode: Default` (the current mode is ✓-prefixed). Run `$V press bypassPermissions`. A `<< status` line contains `🔒 Bypass`. A following write request completes with no `interactive` line.
- **Startup mode.** Run `$V down && $V up --mode bypassPermissions`, then ask for a write. No `interactive` line appears, and the file exists.
- **Proof.** `$V log` shows the prompt, press, and reply sequence. List `work/proj/` before `$V down`.

## Gotchas

- `Deny` and `📝 Deny + Note` share the value `deny`. Without `--text` you get plain Deny.
- A plain Deny may end the turn with the agent's acknowledgement or with `Turn cancelled.`, depending on the engine. Assert the file system, not the wording.
- `/mode` is per chat and resets on `/new`. The startup mode never shows a `🔒` badge.
- Codex (ACP) maps tools to actions differently. Preview text and tool names differ from Claude Code.
- Home (`dm`) defaults to `bypassPermissions`, but `/mode` there still shows `Current mode: Default` (it reads the daemon mode, not the assistant default). Pressing `default` really does switch home to prompting, even though the status line shows no change.
- While a prompt is pending, the turn is blocked. `$V send` to the same chat queues behind it rather than answering it.
