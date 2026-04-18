import fs from "node:fs";
import path from "node:path";

/**
 * Read all .md files from a directory, sorted alphabetically.
 * Returns empty array if directory doesn't exist.
 */
function readMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), "utf-8").trim())
    .filter(Boolean);
}

/**
 * Assemble the system prompt from framework and user instruction files.
 * Framework content comes first, user content appended after.
 * Returns undefined if no content found in either directory.
 */
export function assemblePrompt(
  frameworkDir: string,
  instructionsDir: string,
): string | undefined {
  const framework = readMarkdownFiles(frameworkDir);
  const user = readMarkdownFiles(instructionsDir);

  if (framework.length === 0 && user.length === 0) return undefined;

  const parts: string[] = [];

  if (framework.length > 0) {
    parts.push(framework.join("\n\n---\n\n"));
  }

  if (user.length > 0) {
    parts.push(user.join("\n\n---\n\n"));
  }

  return parts.join("\n\n");
}
