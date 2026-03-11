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

- Routes messages between your phone and your coding agent (Telegram today, Slack planned)
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

## Architecture

Two interfaces keep the core thin: **Channels** (Telegram, Slack, ...) handle messaging, **Engines** (Claude Code, Codex, Kiro, ...) handle the agent. The orchestrator routes between them — adding a channel or engine means adding a file. Details in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

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
