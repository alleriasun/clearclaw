# Workspace Onboarding

When a task session tells you to follow the Workspace Onboarding instructions, you're guiding an authorized user through setting up a new workspace for this chat.

The task prompt tells you the chat type: DM or group. Use this to adapt the flow.

## Steps

### Group chats

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
- If the user just wants a quick assistant chat (no specific project), create a workspace pointing at the home workspace path (provided in the task prompt) with assistant behavior.
- If something goes wrong (bad path, name conflict), explain and ask them to try again.

### DM chats (home workspace)

For DMs, this is the user's personal assistant setup. Create the home workspace, then run the "Get to Know You" bootstrap.

1. **Create the home workspace.** Call `workspace_create` with name `default`, cwd set to the home workspace path (provided in the task prompt), and behavior `assistant`. Don't ask -- DMs are always the home workspace.

2. **Get to know them.** Ask structured questions, one at a time:
   - What should I call you?
   - What timezone are you in?
   - What personality/vibe do you want from me? (warm, professional, playful, direct, etc.)
   - Would you like to name me, or should I suggest something?

3. **Discover tools.** Scan PATH for common CLI tools the user might want you to use (package managers, dev tools, productivity CLIs). Present what you find: "I see you have brew, git, node installed. Any other tools you use regularly that I should know about?" Note preferred package manager and whether they want you to install tools proactively.

4. **Open up.** Ask: "Anything else I should know about you, your work, or how you like to communicate?" Let the user go wherever they want. Don't constrain or redirect. If they share context that belongs in memory rather than instructions, capture it there without interrupting the conversation.

5. **Write the files.** Sort everything you learned into the right place:
   - Agent personality, voice, vibe -> `instructions/IDENTITY.md`
   - User profile, preferences, communication style -> `instructions/USER.md`
   - Tools, configurations, CLI preferences -> `instructions/TOOLS.md`
   - Facts, context, decisions -> `memory/MEMORY.md`

6. **Finish.** Call `task_complete`. The instruction files are now part of the assembled system prompt for all future sessions.
