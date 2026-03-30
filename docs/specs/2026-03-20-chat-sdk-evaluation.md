# Chat SDK Evaluation

**Date:** 2026-03-20
**Status:** Evaluated — not adopting (with one exception)
**Ref:** https://chat-sdk.dev/docs — Vercel's `vercel/chat`, MIT, ~1.5k stars

## What Is Chat SDK?

TypeScript library for building chatbots on 8 platforms (Slack, Teams, Discord, Telegram, Google Chat, GitHub, Linear, WhatsApp) from one codebase. Core concepts:

- **Chat** — entry point, coordinates adapters and routes events to handlers
- **Adapters** — platform-specific implementations (webhook parsing, formatting, API calls)
- **State** — pluggable persistence (thread subscriptions, distributed locking via Redis)

Features: event-driven handlers (mentions, messages, reactions, buttons, slash commands, modals), thread subscriptions, AI streaming with markdown healing, rich UI, serverless-first.

## Why It Doesn't Fit ClearClaw

**Architectural mismatch.** Chat SDK's model: receive event → run handler → post response (bot is the brain). ClearClaw's model: relay to Claude Code CLI and back (CLI is the brain). Their event-handler architecture adds abstraction without removing complexity.

**Our hard parts aren't their concern.** ~650 of ~860 lines across our channels handle permission prompts (interactive buttons, message editing), rolling tool messages (edit-in-place), status messages (pinned, per-turn), message splitting, and typing indicators. None maps to Chat SDK abstractions.

**What it'd replace is trivial.** The ~150-200 lines of "receive message, emit event, post text" per channel are simple and stable. Not worth a dependency.

**Infrastructure friction.** Chat SDK wants webhooks (serverless); we use long-polling (Telegram) and Socket Mode (Slack). They need Redis; we use SQLite. Their thread subscriptions model doesn't match our workspace-to-chat routing.

**Platform coverage we don't need.** 8-platform support is their value prop. We're on 2, with no plans for more.

## What's Worth Stealing

**`remend`** — standalone markdown healing library. ~24KB, zero deps, Apache-2.0, pure TypeScript. Auto-closes incomplete markdown during streaming (`**bold text` → `**bold text**`). Useful when we eventually stream Claude Code output to chat. Not needed yet, but bookmarked.

**Markdown-to-platform conversion** — not available standalone (embedded in adapters). We already handle this in `format.ts` + per-channel escaping. No action.

**Slack slash commands** — Chat SDK wraps Slack's native slash command registration (autocomplete, descriptions, parameter hints). Our backlog has `/status`, `/help`, `/workspace` which currently parse as plain message text. Native slash commands would be a UX upgrade — but we don't need Chat SDK for this; Slack's own API or Bolt handles registration directly. Worth doing natively when we build out more commands.

## Decision

Don't adopt Chat SDK. The dependency cost (SDK + Redis + architectural rework) far exceeds the benefit for a relay needing deep platform-specific UX on 2 channels.

Bookmark `remend` for future streaming work — the one piece that solves a real problem we'll eventually hit, and it's perfectly extractable.