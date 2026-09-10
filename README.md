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

Optional: `PERMISSION_MODE` (`default` | `acceptEdits` | `bypassPermissions` | `plan`), `CLEARCLAW_HOME` (default `~/.clearclaw`).

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
