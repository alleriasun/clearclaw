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
- Optional Grok Bot gateway channel (`grok:` chat IDs) for a CoS / visibility front door — see [docs/channels/grok.md](docs/channels/grok.md)
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
export TELEGRAM_BOT_TOKEN="your-bot-token"
export ALLOWED_USER_IDS="tg:your-telegram-id"

npx clearclaw
```

Or install globally: `npm install -g clearclaw`

Optional: `PERMISSION_MODE` (`default` | `acceptEdits` | `bypassPermissions` | `plan`), `CLEARCLAW_HOME` (default `~/.clearclaw`).

For Slack, set `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and Slack-prefixed
`ALLOWED_USER_IDS` (for example, `slack:U12345`). Private peer-channel spawning
also requires the `groups:write` bot-token scope; reinstall the app after adding
the scope. Shared project sidebar sections require a paid Slack plan, the
`usergroups:read` and `usergroups:write` bot-token scopes, and workspace User
Group permissions set to allow everyone to manage them. Reinstall the app after
changing scopes.

Telegram peer topics require Topics to be enabled manually on a supergroup and
the bot to be an admin with Manage Topics. Private-chat topics require Threaded
Mode to be enabled for the bot in BotFather.

For the Grok Bot host gateway (Tailscale/SSH to `:1340`), set
`GROKBOT_GATEWAY_URL` or `SAND_GATEWAY_URL` plus `SAND_GATEWAY_TOKEN` when
Telegram/Slack tokens are not set. Optional `GROK_RELAY_AGENT_ID`. Bind
workspace `chat_id` to `grok:<agent-uuid>`. Never commit the gateway token.

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
