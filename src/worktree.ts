import { execFileSync } from "node:child_process";
import path from "node:path";

/** Git repo toplevel containing cwd, or null if not a git repo. */
export function repoRootOf(cwd: string): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

/** Create a worktree for repoRoot at the given path (default <repoRoot>/.worktrees/<name>) on a new branch (default feat/<name>, conventional). Returns its path. */
export function createWorktree(repoRoot: string, name: string, wtPath?: string, branch?: string): string {
  const target = wtPath ?? path.join(repoRoot, ".worktrees", name);
  execFileSync("git", ["-C", repoRoot, "worktree", "add", target, "-b", branch ?? `feat/${name}`], { encoding: "utf-8" });
  return target;
}

/** Remove a worktree by path and safe-delete its branch if fully merged. Reads the worktree's actual branch (any naming) and resolves the main repo via --git-common-dir so it works from anywhere. */
export function removeWorktree(wtPath: string): void {
  const commonDir = execFileSync("git", ["-C", wtPath, "rev-parse", "--git-common-dir"], { encoding: "utf-8" }).trim();
  const mainRoot = path.dirname(commonDir);
  let branch: string | undefined;
  try {
    const head = execFileSync("git", ["-C", wtPath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" }).trim();
    if (head && head !== "HEAD") branch = head;
  } catch { /* worktree gone or detached HEAD — nothing to clean */ }
  execFileSync("git", ["-C", mainRoot, "worktree", "remove", "--force", wtPath], { encoding: "utf-8" });
  // Safe-delete the worktree's branch: removed only if fully merged (no unique work); kept otherwise.
  if (branch) {
    try {
      execFileSync("git", ["-C", mainRoot, "branch", "-d", branch], { encoding: "utf-8" });
    } catch {
      /* branch has unmerged work (or is checked out elsewhere) — leave it */
    }
  }
}
