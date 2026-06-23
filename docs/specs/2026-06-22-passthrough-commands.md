# Pass-through commands for the Claude Agent SDK

**Status:** Research findings (not an implementation plan)
**Date:** 2026-06-22
**Engine:** `@anthropic-ai/claude-agent-sdk` v0.2.112 (installed), declared `^0.2.89`
**Scope:** What command pass-through is possible from chat → relay → `query()`, and how ClearClaw would wire it.

## TL;DR

- **Slash commands pass through at the SDK layer, but NOT through the relay today.** The SDK intercepts a slash command only when it is at **position 0** of the prompt string (`prompt: "/compact"`). ClearClaw's `buildPrompt` (`orchestrator.ts:1170`) wraps every message as `[ts] [msgid] sender: <text>`, so the command is never at position 0 and reaches the model as literal text instead. Confirmed live (a `/context` chat message was delivered to the agent, not executed). **Needs a small code path** (below).
- **Custom commands have the same gap.** `.claude/commands/*.md` (and `.claude/skills/<name>/SKILL.md`) are auto-discovered via `settingSources` (already `["user","project","local"]`) and support `$ARGUMENTS`/`$0`/`$1`, `@file`, inline `` !`bash` `` — verified at the SDK layer. But they too must arrive at position 0, so they hit the same `buildPrompt` wrapper problem.
- **The `!cmd` shell-escape is NOT an SDK pass-through.** Top-level bang input is an interactive TUI-only feature. It is not processed in the stream-json path the SDK drives. To ship `!git status` from chat, ClearClaw must implement it itself (intercept before `query()`). Deferred.
- **`extraArgs` + `settings` are adjacent config, not command pass-through.** They are per-workspace operator config (we set them), not commands a user pushes through chat. Documented here because the brief named them; tracked but deferred.

**Smallest path to #1 + #2:** detect a single-message turn whose text starts with `/` (and is not a ClearClaw-owned command), and pass that raw text **bare** to `query()` — bypassing `buildPrompt`'s `[ts] sender:` wrapper so the command sits at position 0. One branch in the turn handler, next to the existing `/new`/`/resume`/`/behavior` checks. The SDK plumbing (`settingSources`, output relay) is already in place; the wrapper is the only blocker. **Deferred: `!`-escape (#3, our own feature) and per-workspace overrides (#4, config).**

## Ground truth sources

1. `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — the `Options` type and the `Query` control interface.
2. `cli.js` (bundled) — confirms where bang/slash handling lives (interactive vs headless).
3. Official docs: `code.claude.com/docs/en/agent-sdk/slash-commands` (current host after redirects from docs.claude.com → platform.claude.com).

All three corroborate the findings below.

---

## 1. Slash commands / custom commands

**Built-in commands** are sent as the prompt string, verbatim, like normal text:

```ts
query({ prompt: "/compact", options: { maxTurns: 1 } })
```

Constraint (quoted from docs): *"Only commands that work without an interactive terminal are dispatchable through the SDK; the `system/init` message lists the ones available in your session."* Example init set: `["clear", "compact", "context", "usage", ...]`. Interactive-only commands (login flows, config UI, the `!` bash mode) are absent from that list and are not dispatchable.

Output reaches the caller in two shapes, both already handled in `src/engine/claude-code.ts`:
- **Local commands** (e.g. `/cost`, `/context`, `/usage`) emit a `system` / `local_command_output` message. The engine already relays this (`claude-code.ts:255`). These bypass the agent loop (no model round-trip).
- **Loop commands** (e.g. `/compact`, custom prompt-expanding commands) run the normal agent loop; their assistant text and `compact_boundary` flow through the existing relay.

**Custom commands** live in `.claude/commands/<name>.md` (project) or `~/.claude/commands/<name>.md` (user). The filename becomes the command name. Once on disk they are *automatically available* because ClearClaw already passes `settingSources: ["user","project","local"]` (`claude-code.ts:172`). Features: YAML frontmatter (`allowed-tools`, `description`, `model`, `argument-hint`), positional args (`$0`/`$1`) and `$ARGUMENTS`, `@file` content includes, and inline bash substitution via `` !`git status` `` *inside the command body* (distinct from top-level bang, see §2). The newer `.claude/skills/<name>/SKILL.md` format is the recommended successor and is invokable the same way (`/name`).

**Discovery surface (not yet used by ClearClaw):**
- `system/init` message carries `slash_commands: string[]` (built-in + custom + plugin).
- `Query.supportedCommands(): Promise<SlashCommand[]>` returns `{ name, description, argumentHint }` (streaming input mode only).

## 2. Shell-escape `!cmd`

**Not available as an SDK pass-through.** In `cli.js`, the bang classifier is:

```js
function ZR(q){ if(q.startsWith("!")) return "bash"; return "prompt" }
function Ap(q){ if(ZR(q)==="prompt") return q; return q.slice(1) }
```

Every call site of `ZR(` is inside the interactive React/ink input box (autocomplete, key handlers, `useState`-style hooks). None sit in the stream-json input pipeline that `query()` drives. So a chat message of `!ls` sent as the prompt is treated as ordinary prompt text by the model, not run as a shell command by the CLI.

The only `!` the SDK path honors is `` !`...` `` *inside a custom-command markdown file* (command-template bash substitution), which is a different mechanism.

**Implication for the backlog item** ("Shell escape commands `!git status`, `!ls`"): this is a **ClearClaw-owned feature**, not relay pass-through. Options, cheapest first:
- (a) Intercept `!`-prefixed messages in the relay before `query()`; run via `child_process` in the workspace `cwd`; return stdout/stderr as a chat message. Full control over formatting and gating, no model tokens.
- (b) Translate `!cmd` into a one-shot prompt that forces the `Bash` tool. Costs a model round-trip and is less deterministic. Not recommended.
- (c) Ship a custom command (e.g. `.claude/commands/sh.md` with `allowed-tools: Bash`) so `/sh git status` works via pass-through. Reuses §1 plumbing but changes the trigger from `!` to `/sh`.

Recommendation: (a) for a true `!`-escape; (c) if a `/`-prefixed trigger is acceptable and we want zero new execution code.

## 3. `query()` pass-through surfaces

From the `Options` type (`sdk.d.ts:977`). The relevant pass-through knobs:

| Option | Type | Pass-through use |
|---|---|---|
| `extraArgs` | `Record<string, string \| null>` | Arbitrary CLI flags (`null` = boolean flag). Per-workspace `--mcp-config`, provider flags, etc. |
| `settings` | `string \| Settings` | Settings file path or inline object; highest-priority user layer. Per-workspace model/permissions/env. |
| `settingSources` | `SettingSource[]` | Which filesystem settings load (`user`/`project`/`local`). Already set. Gates CLAUDE.md + custom commands. |
| `env` | `Record<string,string\|undefined>` | Per-workspace env (API provider creds, base URL). Merged over `process.env`. |
| `mcpServers` | `Record<string,McpServerConfig>` | stdio/sse/http/sdk servers. Already used for the `clearclaw` MCP server. |
| `allowedTools` / `disallowedTools` / `tools` | `string[]` / preset | Restrict or auto-allow tools per workspace. |
| `permissionMode` | `PermissionMode` | Already wired. |
| `canUseTool` | callback | Already wired (permission relay). |
| `hooks` | `Partial<Record<HookEvent, ...>>` | 28 hook events (`PreToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop`, ...). In-process callbacks; can inject context, gate, observe. Not a *chat* pass-through, but a powerful relay-side interception surface. |
| `plugins` | `SdkPluginConfig[]` | Local plugins bundle custom commands + agents + skills + hooks. A packaging surface for batches of pass-through commands. |
| `agents` | `Record<string,AgentDefinition>` | Programmatic subagents. `initialPrompt` is auto-submitted and *processes slash commands*. |
| `model` / `effort` / `thinking` / `maxTurns` / `maxBudgetUsd` | scalars | Per-turn/per-workspace tuning. |

**Streaming-input control methods** (on the returned `Query`, only in streaming-input mode): `interrupt()`, `setPermissionMode()`, `setModel()`, `applyFlagSettings(settings)`, `setMcpServers()`, `toggleMcpServer()`, `reloadPlugins()`, `getContextUsage()`, `supportedCommands()`, `supportedModels()`, `supportedAgents()`, `mcpServerStatus()`, `accountInfo()`, `stopTask()`. These are an alternative to slash commands for things like model switching and context inspection, but require ClearClaw to drive `query()` in streaming-input mode (it currently sends a single prompt per turn).

Note: `extraArgs` and `settings` are the cleanest answers to the backlog's "per-workspace `extraArgs`" item. `settings` (object form) is type-checked and preferable to raw `extraArgs` for known keys (model, permissions, env); `extraArgs` covers anything without a first-class field.

## 4. Feasible vs not

| Capability | Via SDK pass-through? | Notes |
|---|---|---|
| Built-in non-interactive slash commands (`/compact`, `/context`, `/cost`, `/usage`, `/clear`) | Yes | Send as prompt string. Output already relayed. `/clear` needs CLI ≥ 2.1.117 and only matters in streaming-input mode. |
| Built-in interactive commands (login, config UI) | No | Absent from `system/init.slash_commands`. |
| Custom commands (`.claude/commands`, `.claude/skills`) | Yes | Auto-loaded via `settingSources` (already set). Args, `@file`, inline bash. |
| Plugin-provided commands | Yes | Via `plugins` option; `reloadPlugins()` to refresh. |
| Top-level `!cmd` shell escape | No | TUI-only. ClearClaw must implement (intercept + `child_process`, or a `/sh` custom command). |
| Per-workspace CLI/settings overrides | Yes | `extraArgs` + `settings` + `env`. |
| Mid-session model / permission / MCP changes | Yes (streaming-input mode only) | Needs `query()` driven in streaming-input mode. |

## ClearClaw wiring sketch

Minimal additions on top of `src/engine/claude-code.ts`, no new architecture:

1. **Slash commands (already mostly free).** Anything starting with `/` that is not a ClearClaw-owned command (`/behavior`, future `/workspace`, `/status`) flows to `query()` as-is. Already does. To improve UX, capture `slash_commands` from the `system`/`init` message and expose it (e.g. surface in a `/help` reply). Today the engine only matches `local_command_output`; add an `init` branch to read `slash_commands` and stash it on the session.
   - Decide the ClearClaw-vs-Claude command namespace split. `/status`, `/help`, `/workspace`, `/behavior` are *ClearClaw* commands (workspace/session state), intercepted in the channel layer; everything else passes through. Keep a small reserved set; forward the rest.

2. **Shell escape (`!cmd`).** New, channel-layer feature. In the relay, if a message starts with `!` (and is not a known false positive), do not call `query()`; run the remainder via `child_process` in the workspace `cwd`, stream stdout/stderr back as a chat message, gate by the workspace's permission mode. Keep it out of the engine (it is not a relay of the CLI).

3. **Per-workspace overrides.** Extend `RunTurnOpts` / workspace config with optional `extraArgs?: Record<string,string|null>`, `settings?: string | Settings`, `env?: Record<string,string>`, and spread them into the `query({ options })` object alongside the existing fields. Mirrors how `mcpServers`/`appendSystemPrompt` are already threaded (`types.ts:92`, `orchestrator.ts:367`).

## Status: #1/#2 implemented; #3/#4 deferred

**#1 Built-in slash commands + #2 custom commands — IMPLEMENTED (2026-06-22).**
`slashCommandPrompt(messages)` in `orchestrator.ts` returns the bare command text for a single user-typed message whose text starts with `/`; the turn's prompt is now `slashCommandPrompt(messages) ?? buildPrompt(messages)`. A lone slash command therefore reaches `query()` at position 0 (where the CLI intercepts it) instead of being wrapped by `buildPrompt` and sent to the model as text. ClearClaw's own commands (`/new`, `/resume`, `/behavior`) are handled and returned earlier in the turn handler, so they never reach this branch. Args (`/refactor src/x.ts`) still start with `/`, so they pass; scheduler/peer prompts and multi-message batches are excluded by the guard. `tsc --noEmit` clean. End-to-end live confirmation pends the next build (which restarts the relay).

**Deferred (documented here, not built):**
- **#3 `!cmd` shell escape** — ClearClaw-owned feature (intercept + `child_process`, or a `/sh` custom command). Not an SDK pass-through.
- **#4 Per-workspace overrides** (`extraArgs`/`settings`/`env`) — operator-side config, not command pass-through.

**Optional small win (not required):** capture `system/init.slash_commands` to power a `/help` listing of the passed-through commands.

### Verification (runtime, 2026-06-22)

Ran a throwaway `query()` harness (no build, no relay restart) mirroring `claude-code.ts`:
- **#1** `prompt:"/context"` → `system/init` carried `slash_commands` including `compact`/`context`/`cost`, and the command returned the context-usage breakdown. Confirmed.
- **#2** dropped `.claude/commands/ccverify.md` into a temp project cwd with `settingSources:["project"]`; `ccverify` then appeared in `slash_commands` and `/ccverify` expanded and ran (model replied `PONG`). Custom-command auto-discovery + pass-through confirmed.

Nuance: in this SDK version (v0.2.112) `/context` output arrived as **assistant text**, not `local_command_output`. The engine relays assistant text unconditionally, so output still surfaces; `local_command_output` (relayed at `claude-code.ts:255`) covers other local commands. Either path reaches chat.

**Live correction (same day):** a real `/context` chat message was delivered to the agent as a normal turn, not executed. Root cause: `buildPrompt` (`orchestrator.ts:1170`) wraps every message as `[replyLine][ts] [msgid] sender: <text>`, so the command never sits at position 0 and the SDK does not intercept it. The bare-string harness above passed exactly because it skipped this wrapper. Corrected conclusion: #1/#2 need the one-branch bare-prompt path described in the Status section — they are not zero-code through the relay. Lesson: verify integration through the real prompt-assembly path, not just the bare SDK call.

## Backlog cross-refs (`docs/TASKS.md`)

- `Shell escape commands (!git status, !ls)` → not pass-through; build per option (a)/(c) above.
- `Per-workspace extraArgs for SDK` → `extraArgs` + `settings` + `env` confirmed; sketch in wiring step 3.
- `/help`, `/status`, `/workspace` → ClearClaw-owned commands; can list passed-through Claude commands via captured `slash_commands`.
