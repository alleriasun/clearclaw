# List & Resume Sessions

**Date:** 2026-03-15
**Status:** In progress

---

## Context

ClearClaw auto-resumes the current session per workspace — each turn passes the stored `sessionId` to the SDK's `query({ resume })`. `/new` clears the stored ID to start fresh. But there's no way to go back to a previous session. If you `/new` and then want to return to what you were working on, you can't.

The Claude Agent SDK exposes `listSessions({ dir })` which returns session metadata (ID, summary, timestamps, git branch) for a project directory. Resume is already wired — we just need to let the user pick a different session ID.

---

## Design Decisions

### Why `listSessions` lives on the Engine interface

`listSessions` queries session storage that's specific to the Claude Code SDK (`~/.claude/projects/...`). The alternative is calling the SDK function directly from the orchestrator, bypassing the Engine abstraction. We keep it on Engine because the orchestrator shouldn't know about the SDK — the engine is the abstraction boundary between ClearClaw and whatever backend runs turns. If a different engine ever manages sessions differently, it implements the same interface. This is consistent with how `runTurn` already abstracts the SDK's `query()`.

### Interactive buttons over text reply

`/resume` is a control command, not a conversation turn. The user should pick from a list interactively (buttons), not type a number or session ID. This matches how permission prompts work. Session lists are capped at 10 (passed as `limit` to the SDK to avoid loading all session data), so button count stays manageable.

### Busy guard

`/resume` is blocked during an active turn (`state.busy`). Unlike `/new` which sets the session to `null` (harmless if overwritten), `/resume` sets a specific historical session ID — if the in-flight turn's `done` event overwrites it immediately after, the user's selection is silently lost. Better to block with a short message: "A turn is in progress. Wait for it to finish before switching sessions."

---

## Design

### Engine interface

Add `listSessions` to the `Engine` interface and a `SessionInfo` type:

```typescript
// types.ts
export interface SessionInfo {
  sessionId: string;
  summary: string;       // from SDK — already resolved (customTitle > auto > firstPrompt)
  lastModified: number;  // ms since epoch
  gitBranch?: string;
}

export interface Engine {
  name: string;
  runTurn(opts: RunTurnOpts): AsyncIterable<EngineEvent>;
  listSessions(cwd: string): Promise<SessionInfo[]>;
}
```

`SessionInfo` is our own type, decoupled from `SDKSessionInfo`. We only surface fields useful for the UI. The engine maps from SDK types to ours.

### Engine implementation

In `claude-code.ts`, import `listSessions` from the SDK and implement the method:

```typescript
async listSessions(cwd: string): Promise<SessionInfo[]> {
  const sessions = await listSessions({ dir: cwd, limit: 10 });
  return sessions
    .sort((a, b) => b.lastModified - a.lastModified)
    .map(s => ({
      sessionId: s.sessionId,
      summary: s.summary,
      lastModified: s.lastModified,
      gitBranch: s.gitBranch,
    }));
}
```

SDK handles the cap via `limit: 10` to avoid loading all session data. In-app sort is defensive (SDK order not guaranteed).

### `/resume` command

New command in the orchestrator, mirroring `/new`:

1. User sends `/resume`
2. If `state.busy` → send "A turn is in progress. Wait for it to finish before switching sessions." and return
3. Resolve workspace via `workspaceStore.byChat(chatId)` — if none, send "No workspace linked to this group."
4. Orchestrator calls `engine.listSessions(ws.cwd)`
5. If empty → send "No sessions found for this workspace"
6. Format each session as a button: `"{summary} — {timeAgo}"` (e.g. `"Fix auth bug — 2h ago"`)
7. Send via `channel.sendInteractive` — one button per session, single column
8. User picks one → `workspaceStore.setSession(ws.name, pickedSessionId)`
9. Send confirmation: `"Resumed session: {summary}"`
10. Next `runTurn` automatically uses the new session ID via the existing `{ resume }` flow

No turn is executed — the command only changes the stored session pointer.

### Button layout

Each session gets its own row with one button. The button label shows the summary (truncated to ~40 chars if needed) and relative time. The button value is the session ID.

```
[Fix auth bug — 2h ago        ]
[Refactor orchestrator — 1d ago]
[Add Slack channel — 3d ago    ]
```

If the current session is in the list, mark it: `"✅ Fix auth bug — 2h ago"`.

### Time formatting

Simple relative time helper (no dependencies): "just now", "5m ago", "2h ago", "1d ago", "3d ago". Only needs minute/hour/day granularity.

---

## File changes

| File | Change |
|------|--------|
| `src/types.ts` | Add `SessionInfo` interface, add `listSessions` to `Engine` |
| `src/engine/claude-code.ts` | Import SDK `listSessions`, implement `Engine.listSessions` |
| `src/orchestrator.ts` | Add `/resume` command handler |
| `src/format.ts` | Add `timeAgo()` helper for relative timestamps |

---

## Future extensions (not in scope)

- **Rename sessions** — SDK supports `customTitle`, CLI supports `/rename`
- **Custom session IDs** — SDK's `sessionId` option for named sessions
- **Fork session** — SDK's `forkSession: true` for branching from a point
- **Session preview** — SDK's `getSessionMessages` to show conversation snippets before resuming
