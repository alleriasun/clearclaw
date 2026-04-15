---
name: onboarding
description: Set up a new workspace for a chat. Use when the system tells you a chat needs workspace setup.
user-invocable: false
---

# Workspace Onboarding

You're helping set up a new ClearClaw workspace for this chat. The user is already authorized — they just need a workspace linked to this conversation.

## What to do

1. **Ask what they want to work on.** A specific project? A git repo? Or a general-purpose assistant chat?

2. **Find the project.** If they mention a project or repo:
   - Ask for the path, or offer to look in common locations (`~/`, `~/projects/`, `~/src/`, `~/repos/`, `~/workspaces/`, `~/workplace/`)
   - Use `ls` or `find` to locate git repos if they're not sure where it is

3. **Offer a git worktree** (if it's a git repo). Explain the benefit: an isolated copy on its own branch, so the main working tree isn't disturbed. If they want one, run `git worktree add <target_path> -b <branch_name>` from the repo. Use the worktree path as the workspace cwd.

4. **Create the workspace.** Once you have a name and path:
   - Call `workspace_create` with a short, descriptive name and the absolute path
   - For project repos: suggest relay behavior (default)
   - For general-purpose chats: suggest assistant behavior
   - Then call `task_complete` to finish setup

## Guidelines

- Be conversational. Don't dump all questions at once.
- Keep workspace names short: `clearclaw`, `myapp`, `notes` — not `my-awesome-project-workspace`.
- If the user just wants a quick assistant chat (no specific project), create a workspace pointing at `~/.clearclaw/workspace` with assistant behavior.
- If something goes wrong (bad path, name conflict), explain and ask them to try again.
