# ClearClaw

A transparent relay daemon that connects your phone to your terminal's AI agent. No containers, no cloud, no bloat.

---

## Problem

You want to talk to Claude Code (or Kiro, or whatever agent CLI comes next) from your phone. Not a chatbot. Not a web wrapper. The actual agent running on your actual machine, with your files, your MCP servers, your SSH keys, your everything.

Most projects in this space add their own orchestration layer — their own permission system, config format, plugin model, security boundary. That's a valid approach, but it means you end up managing two systems: the CLI you already configured, and the middleware on top of it.

ClearClaw takes a different approach: stay transparent.

---

## Why "Clear"

The name is the design constraint. Three meanings, all enforced:

### 1. Clear relay — nothing hidden between you and the engine

ClearClaw is a transparent pipe. Your message goes in, the CLI's output comes back. Permission prompts, tool calls, plan approvals — they're relayed exactly as the CLI presents them, forwarded to your chat as buttons and formatted text. No rewriting, no filtering, no "smart" summarization layer.

When Claude Code asks "Allow Bash(rm -rf node_modules)?", you see that exact prompt on your phone with Allow / Deny / Allow for session. The relay doesn't interpret it, doesn't apply its own rules, doesn't silently approve anything.

### 2. Clear of duplication — the CLI already handles it

Claude Code already has a permission system (`settings.json`, hierarchical allow/deny rules, per-tool specifiers). It already has memory (`CLAUDE.md`). It already has MCP config, system prompts, session management, tool allowlists. It already has plan mode, compact mode, cost tracking.

ClearClaw inherits all of that by simply spawning the agent in your project directory. Your `~/.claude/settings.json` applies. Your project's `.claude/settings.local.json` applies. Your MCP servers are available. Your CLAUDE.md is loaded. There's nothing to re-configure because there's nothing duplicated.

Other projects build their own permission layer, then have to keep it in sync with the CLI's. They build their own config format, then need migration scripts. They build their own memory system, then it drifts from what the terminal session sees. ClearClaw has none of these problems because it doesn't have any of these systems.

### 3. Clear implementation — small, auditable, no yolo mode hiding in the codebase

The entire relay is under 2K lines of TypeScript. Six source files. You can read every line in an afternoon. There's no embedded agent runtime, no plugin framework, no eval-based extension system, no "just set `bypassPermissions: true`" buried in the container config.

When you're giving a process access to your machine — your files, your keys, your credentials — you should be able to verify what it does. ClearClaw is small enough to audit completely and transparent enough that there's nowhere for unsafe defaults to hide.

---

## What ClearClaw Does

- Routes messages between your phone (Telegram, eventually Slack) and the CLI agent
- Relays permission prompts as interactive buttons
- Relays AskUserQuestion as option menus
- Relays plan approval as Approve / Reject
- Maps chat channels to project workspaces (each chat = a CWD)
- Manages sessions so you can start in the terminal and continue from your phone
- Shows typing indicators while the agent works
- That's it

## What ClearClaw Does NOT Do

- Own a permission system (the CLI has one)
- Have its own tool allowlist (the CLI has one)
- Have its own MCP config (the CLI has one)
- Manage memory or system prompts (CLAUDE.md lives in your project)
- Run inference or embed an agent runtime
- Provide a plugin or extension system
- Require containers, VMs, or cloud services

When in doubt about where logic belongs: in the CLI, not here.

---

## Architecture

One daemon process. Starts on boot. Your phone sends a message → the daemon spawns your agent via the Claude Agent SDK → the agent does its thing → the response comes back. Everything stays on your machine.

Two interfaces keep the core thin:

- **Channels** (Telegram, Slack, etc.) — send/receive messages, buttons, typing indicators
- **Engines** (Claude Code, eventually Kiro) — spawn agent, stream output, relay permissions

The orchestrator in the middle is ~200 lines. It routes inbound messages to the right engine and outbound events to the right channel. Adding a channel or engine means adding a file, not changing the core.

Full design details — interfaces, schemas, permission relay, session management — are in [`DESIGN.md`](DESIGN.md).

---

## Shipping Phases

Small increments. Each phase ships something usable:

1. **Phase 1** ✅ — Telegram + Claude Code + single workspace. The minimal working relay.
2. **Phase 2** — Multi-workspace. Channel-per-workspace routing, per-workspace config.
3. **Phase 3** — Multi-engine. Kiro CLI behind the engine interface.
4. **Phase 4** — Slack. Second channel proves the interface abstraction.
5. **Phase 5** — Scheduler. Cron-based tasks that make it an assistant, not just a relay.

---

## What We Deliberately Skip

- **Containers.** The whole point. Your agent runs as you, on your machine, with your tools.
- **Plugin/extension system.** Premature abstraction. Add features by editing code.
- **Companion apps.** No macOS menu bar, no iOS app. Telegram/Slack IS the interface.
- **Multi-user.** Single-user daemon. One person, one machine, one assistant.
- **Web UI / Canvas.** The phone is the UI. Period.
- **Embedded agent runtime.** We don't run inference. We spawn your existing CLI agent.
- **Complex config.** One config file. No env-var refs, no includes, no migrations.

---

## Prior Art

| Project | URL | Description |
|---|---|---|
| OpenClaw | [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw) | Multi-channel personal AI assistant with plugin system and embedded runtime |
| NanoClaw | [github.com/qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) | Lightweight Claude assistant with container isolation |
| remotecode | [github.com/kcisoul/remotecode](https://github.com/kcisoul/remotecode) | Telegram-to-Claude-Code relay with HITL permissions |

