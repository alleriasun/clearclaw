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

/** Create a worktree at <repoRoot>/.worktrees/<name> on new branch peer/<name>. Returns its path. */
export function createWorktree(repoRoot: string, name: string): string {
  const wtPath = path.join(repoRoot, ".worktrees", name);
  execFileSync("git", ["-C", repoRoot, "worktree", "add", wtPath, "-b", `peer/${name}`], { encoding: "utf-8" });
  return wtPath;
}

/** Remove a worktree by path; resolves the main repo via --git-common-dir so it works from anywhere. */
export function removeWorktree(wtPath: string): void {
  const commonDir = execFileSync("git", ["-C", wtPath, "rev-parse", "--git-common-dir"], { encoding: "utf-8" }).trim();
  const mainRoot = path.dirname(commonDir);
  execFileSync("git", ["-C", mainRoot, "worktree", "remove", "--force", wtPath], { encoding: "utf-8" });
}
