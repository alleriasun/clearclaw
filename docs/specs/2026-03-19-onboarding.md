# Workspace Onboarding — First Install to First Conversation

**Date:** 2026-03-19
**Status:** Implemented

## Context

ClearClaw's first-run experience was a 9-step manual process: create bot, figure out your user ID, set env vars, hand-edit `workspaces.json`, grep logs for `chat_id`, restart. Steps 3/5/6/7/8 were pure friction the bot could handle itself.

The goal: `clearclaw setup` → two prompts (channel + token) → DM the bot → approve on console → done. Under a minute.

### How Other *Claws Handle It

**OpenClaw** — CLI terminal wizard (`openclaw onboard`). Auth via per-channel `dmPolicy` with a `"pairing"` default: unknown DM → bot sends 8-char code + user ID → owner runs `openclaw pairing approve <channel> <code>` → user persisted to `~/.openclaw/credentials/`. No restart. No runtime workspace creation.

**NanoClaw** — Claude Code `/setup` skill guides first-time install. Runtime workspace management via MCP server (stdio) exposed to the agent inside containers. Agent calls `mcp__nanoclaw__register_group` → file-based IPC → host persists. Only the "main" group's agent can register new groups.

**ClearClaw's approach** takes OpenClaw's pairing for auth (proven pattern) and focuses on explicit CLI-driven setup. Interactive `clearclaw setup` validates the token by connecting before saving, so the user gets immediate feedback. Runtime workspace provisioning (group wizard, DM auto-create) is deferred to a model-driven follow-up.

## Design

### CLI Commands

Explicit subcommands separate one-time setup from the long-lived daemon, avoiding stdin conflicts when transitioning to a background service (launchd/systemd).

- **`clearclaw setup`** — interactive first-run. Collects channel type + token → saves to `~/.clearclaw/config.json` (0o600) → connects → waits for first DM → bot sends pairing code → console prompts for code → `approve` path → exits.
- **`clearclaw daemon`** — starts the relay. Reads saved config. No prompts. Fails fast with a clear error if no channel config found.
- **`clearclaw approve <code>`** — headless pairing approval. For environments where the daemon runs with env vars and no terminal is available.
- **`clearclaw`** (bare) — help text, reserved for future use.

### Ideal First-Run

```
$ clearclaw setup
ClearClaw setup

Channel [telegram/slack]: telegram
Telegram bot token: <paste>
Saved to ~/.clearclaw/config.json

Connecting...
Connected! Waiting for a DM — message the bot from your chat app.

→ Message from Paddy (tg:12345)
  Enter pairing code to approve: ABCD1234
  Approved Paddy (tg:12345)

Setup complete! Start the daemon:
  clearclaw daemon
```

### Auth and Pairing

`ALLOWED_USER_IDS` env var is now optional. Unknown user DMs → bot sends pairing code → owner runs `clearclaw approve <code>` → user persisted to `config.json`. No restart — file is re-read on every incoming message.

Both `clearclaw setup` and `clearclaw daemon` use the same pairing code approval path. In setup, the owner enters the code at the console; in daemon mode, they run `clearclaw approve <code>` separately.

`ALLOWED_USER_IDS` env var IDs are kept in a private in-memory set — no disk writes. Pairing-approved users are persisted to `config.json` and hot-reloaded on each message.

Pairing codes: 8 chars from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no ambiguous chars), 1-hour expiry, max 3 pending per user (idempotent — same user gets same code if one is still active).

### Workspace Provisioning

Workspace creation is **explicit only** — via `clearclaw setup` (creates the default workspace during first-run approval) or `clearclaw approve <code>` (creates default workspace on headless pairing). Unmapped chats receive "No workspace linked to this chat." until a workspace is created.

Runtime provisioning (auto-create on first DM, group wizard) was considered and deferred. The intent is to replace rigid orchestrator-side state machines with model-driven conversation in a follow-up spec — the model handles workspace setup naturally via a `workspace_create` tool.

`msg.chatType` (`"dm" | "group"`) is populated on every `InboundMessage` from `ctx.chat.type` (Telegram) or channel ID prefix (Slack DMs start with `D`), available for future routing logic.

### Config Storage

All state lives in one file: `~/.clearclaw/config.json` (0o600). Replaces the previous proliferation of separate JSON files. Env vars always take precedence — `TELEGRAM_BOT_TOKEN=xxx clearclaw daemon` works without running setup.

The `Config` class handles both env var resolution (`resolve()`) and file-backed persistence. File is re-read on every store call — no file watching, no signals.

## Key Design Decisions

**Why separate `setup` and `daemon` commands?** Interactive readline and a long-lived background service can't safely share the same process. Setup exits cleanly; the daemon starts fresh. This also makes launchd/systemd integration trivial — register `clearclaw daemon`, not `clearclaw`.

**Why pairing codes over manual `ALLOWED_USER_IDS`?** The env var approach required the user to know their own user ID before first contact. Pairing flips it: DM first, your ID surfaces automatically.

**Why a unified `config.json`?** The earlier design had separate `authorized-users.json`, `pending-pairings.json`, and `workspaces.json`. One file is simpler to reason about, simpler to back up, and eliminates the question of which file to look at when debugging. 0o600 on one file covers all sensitive data (bot token + user list).

**Why no runtime workspace auto-creation?** A rigid orchestrator-side state machine (wizard or auto-detect) is complexity that belongs to the model, not the relay. ClearClaw's role is routing and primitives. Group/DM onboarding via natural conversation — handled by a future model-driven spec — is a cleaner fit than hardcoded prompt/response steps.
