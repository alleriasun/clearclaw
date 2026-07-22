# Spin-out v2: thin relay primitives + agent-improvised prep (design stub)

> Direction-setting follow-on to the 1b/1c peer-spawning work (`docs/specs/2026-06-13-projects-and-peer-spawning.md`). Not yet built. The minimal worktree/cwd fix (commit `fix(1c): create the worktree for an explicit cwd`) patches the immediate breakage; this spec is the deliberate redesign behind it.

## Problem

`spin_out` is a monolithic MCP tool that bakes *improvisable judgment* into rigid relay code: where the cwd is, whether the repo is git, whether to make a worktree and where, which branch, forum-vs-manual, project resolution. Every new shape of repo trips a new edge. Observed gaps (the worktree cluster found in real use, June 2026):

- An explicit `cwd` was bound as-is and never created (peers pointed at a missing dir). *(fixed in the minimal patch)*
- A missing cwd surfaced as "claude binary not found" rather than the real cause. *(fixed in the minimal patch)*
- The manual claim path `mkdir`s an empty non-git dir when a worktree was intended.
- Branch-name drift: archive cleanup assumed a `peer/<name>` branch and missed differently-named ones. *(fixed: cleanup now reads the worktree's actual branch, and branches are conventional + agent-chosen, default `feat/<name>`)*
- The agent flies blind: it must infer the cwd, the `.worktrees/<name>` convention, when to worktree vs share, and project resolution, all from a two-line tool description.

This contradicts ClearClaw's own rule (`CLAUDE.md`): logic belongs in the CLI/agent, not the relay.

## Direction

Stop making the tool smarter; let the agent improvise the prep, guided by a skill, and keep only the irreducible parts in the relay.

- **Relay primitives (stay tools — only the relay can do these):** create the chat surface (forum topic), bind a workspace to a chat, deliver the brief. The relay never guesses a filesystem path again.
- **Agent-improvised prep (a skill):** assess the repo, choose the cwd, `git worktree add` it via bash, pick the target project, then call the thin relay tool with a cwd that **already exists**. The skill carries the conventions (`.worktrees/<name>`, `peer/<name>` branches, when to worktree vs share, git-vs-non-git) and the human-confirm step.

This deletes the whole cwd/worktree footgun by construction: the tool receives a real path because the agent made it.

## Open questions

- **Approval gate.** Today it's the Spawn/Manual/Cancel buttons inside `spin_out`. In a skill-driven flow the agent prepares files first, so the gate moves to an explicit "confirm with the user before spawning" step (or a small confirm in the thin bind tool). Decide which.
- **How thin is the tool?** One `spawn_peer(project, name, cwd, brief)` that assumes cwd exists, or separate `create_topic` + `bind_workspace` + deliver primitives the skill composes.
- **Manual claim path.** Fold it into the same skill (agent preps the worktree before `workspace_create`) so it stops `mkdir`-ing bare dirs.
- **Branch convention (decided).** Conventional, agent-chosen branches (`feat/…`, `fix/…`, `chore/…`; default `feat/<name>`); archive cleanup reads the worktree's actual branch, so naming is free. Landed in the minimal fix; the skill should guide the agent to pick a sensible prefix per the brief.

## Status

Proposed. Sequenced after the minimal fix lands (PR #31). Worth a short design pass (a couple of thin-tool/skill splits, compared) before building.
