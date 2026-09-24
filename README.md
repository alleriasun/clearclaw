# ClearClaw

Your coding agent, from your phone — personal assistant + project workspaces on your machine, built on the CLI's permissions, config, and memory instead of replacing them.

## Why

You want to talk to your coding agent from your phone. Not a chatbot — the actual agent on your actual machine, with your files, your tools, your everything.

Most projects in this space add their own permission system, config format, plugin model. You end up managing two systems: the CLI you already configured, and the middleware on top.

ClearClaw reuses what the CLI already has:

- **No duplicate permissions.** The CLI has `settings.json` with allow/deny rules. ClearClaw relays prompts as buttons — the CLI's rules apply as-is.
- **No duplicate config.** Your settings, MCP servers, tool allowlists — all loaded automatically. Nothing to re-configure.
- **No duplicate memory.** `CLAUDE.md` lives in your project. The CLI loads it. ClearClaw doesn't touch it.
- **Small and auditable.** ~1500 lines, 7 files. No plugin system, no eval, no embedded runtime.

## What It Does

- Routes messages between your phone and your coding agent through Telegram or Slack
- Permission prompts with diffs, tool status, and feedback — like the terminal, on your phone
- Maps chat groups to project workspaces — each group = a working directory
- Personal assistant workspace for non-project conversations
- Session continuity between terminal and phone

## What It Doesn't Do

- Own permissions, config, memory, or system prompts — the CLI owns those
- Run inference or embed an agent runtime
- Require containers, VMs, or cloud services
- Provide a plugin or extension system

## Quick Start

```bash
npm install -g clearclaw
clearclaw setup
clearclaw daemon
```

Setup saves the channel tokens and default engine, then asks you to DM the bot and approve its pairing code. The platform supplies your user and chat IDs; you do not need to copy them into environment variables. Additional pairing requests can be approved with `clearclaw approve <code>`.

Home is created automatically and connects to the approved DM. Start chatting immediately. Ask from home or another workspace to create a project and workspace together. If you choose a manual chat, create the group and send `/connect <workspace>` there (Slack: `/cc connect <workspace>`).

Existing environment-based installations remain supported: channel token variables and `ALLOWED_USER_IDS` override saved configuration. An authorized user's first root DM binds an unbound home. Existing bindings are preserved.

Send `/recap` (Slack: `/cc recap`) to replay the current session's last three prompts and their replies, including any reply still in progress. It reads history from the workspace's engine, so it also includes work done in the CLI. Use `/resume` separately when you want to select a different session.
If the engine locks history during an active turn, retry after that turn finishes.

Optional: `PERMISSION_MODE` (`default` | `acceptEdits` | `bypassPermissions` | `plan`), `CLEARCLAW_HOME` (default `~/.clearclaw`).

### Engine executable and config paths

Setup stores the selected engine's resolved CLI executable in `~/.clearclaw/config.json` as `engines[].path`. Claude Code passes this path to the Agent SDK. Kiro runs this path with the `acp` argument. Codex starts ClearClaw's pinned, patched `codex-acp` adapter through Node and passes the configured Codex CLI path to it as `CODEX_PATH`.

For Codex, setup prefers an installed `codex` CLI; if none is on `PATH`, it omits the override and uses the bundled executable.

Without a configured override, Kiro resolves `kiro-cli` from `PATH`. Codex preserves an inherited `CODEX_PATH`, otherwise its adapter uses the bundled Codex executable.

Executable and config paths belong to the engine and apply wherever that engine is used. Set optional `engines[].configPath` to an absolute settings-file path for Claude Code or Codex:

```json
{
  "engines": [
    { "name": "claude-code", "default": true, "configPath": "/path/to/dotfiles/claude/settings.json" },
    { "name": "codex", "configPath": "/path/to/dotfiles/codex/alleriasun.config.json" }
  ]
}
```

Keep any existing `path` overrides when adding `configPath`. No shell export or copy to the agent's home directory is required for these files.

- **Claude Code:** passes the file through the SDK's `settings` option (`--settings`). User, project, and local settings sources remain enabled. Explicit settings override conflicting scalar values in those sources; most lists merge under Claude's native rules. Existing user settings and symlinks remain the user's choice.
- **Codex:** reads the JSON object at each adapter launch and supplies it as `CODEX_CONFIG`, adding ClearClaw's assembled developer instructions on top. An explicit file replaces inherited `CODEX_CONFIG` input; omitting `configPath` preserves environment-based behavior. Missing, malformed, or non-object JSON fails the launch. The adapter passes these values as thread config; native Codex still owns its normal configuration layers and startup plugin catalog.

Restart the daemon after changing `engines` entries. File contents are read again on subsequent launches. Kiro does not support `configPath`. This does not add named-profile support or change native CLI launches outside ClearClaw.

For Slack, setup saves the bot and app tokens; environment-based installs can use
`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and Slack-prefixed `ALLOWED_USER_IDS`. Private peer-channel spawning
also requires the `groups:write` bot-token scope; reinstall the app after adding
the scope. Shared project sidebar sections require a paid Slack plan, the
`usergroups:read` and `usergroups:write` bot-token scopes, and workspace User
Group permissions set to allow everyone to manage them. Reinstall the app after
changing scopes.

Telegram peer topics require Topics to be enabled manually on a supergroup and
the bot to be an admin with Manage Topics. Private-chat topics require Threaded
Mode to be enabled for the bot in BotFather.

## Architecture

Two interfaces keep the core thin: **Channels** (Telegram, Slack, ...) handle messaging, **Engines** (Claude Code, Codex, Kiro, ...) handle the agent. The orchestrator routes between them — adding a channel or engine means adding a file. Details in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Project lifecycle contracts and design decisions are in [Projects and peer spawning](docs/specs/peer-spawning.md).

## Prior Art

| Project | Description |
|---------|-------------|
| [Claude Code Remote Control](https://docs.anthropic.com/en/docs/claude-code/remote-control) | Anthropic's first-party `/rc`. Max-only, single session, no daemon. |
| [OpenClaw](https://github.com/openclaw/openclaw) | Full monolith with plugin system. [Security concerns](https://github.com/openclaw/openclaw/security). |
| [NanoClaw](https://github.com/qwibitai/nanoclaw) | Container-isolated, multi-channel. |
| [remotecode](https://github.com/kcisoul/remotecode) | Telegram relay with HITL permissions. |
| [Claude-Code-Remote](https://github.com/JessyTsui/Claude-Code-Remote) | Multi-channel: Telegram, Discord, Email, LINE. |
| [claude-telegram-relay](https://github.com/godagoo/claude-telegram-relay) | Minimal Telegram daemon. |
| [Happy Coder](https://happy.engineering/) | Native apps, E2EE, multi-session. Polished, closed-source. |
| [Paseo](https://paseo.sh/) | Agent-agnostic daemon (Claude Code, Codex, OpenCode). E2EE. |
| [yottoCode](https://yottocode.com/) | Native macOS + Telegram, voice I/O. |

## License

[MIT](LICENSE)
