import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import log from "./logger.js";

// A cloud-synced instructions dir (OneDrive/iCloud "dataless" placeholder) can
// block a read indefinitely. Reading it synchronously froze the whole relay.
const READ_TIMEOUT_MS = 5000;

/** Read a file, giving up after READ_TIMEOUT_MS. Returns null on timeout or error. */
async function readFileOrSkip(file: string): Promise<string | null> {
  // ponytail: Promise.race, not AbortSignal — an abort can't interrupt a read
  // already blocked in libuv's threadpool, which is exactly what a
  // cloud-placeholder file does.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
  });
  try {
    const content = await Promise.race([fsp.readFile(file, "utf-8"), timeout]);
    if (content === null) {
      log.warn("[prompt] timed out reading %s after %dms — skipping", file, READ_TIMEOUT_MS);
      return null;
    }
    return content.trim();
  } catch (err) {
    log.warn({ err }, "[prompt] could not read %s — skipping", file);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read all .md files from a directory, sorted alphabetically.
 * Unreadable files are reported by name instead of silently dropped.
 */
async function readMarkdownFiles(dir: string): Promise<{ contents: string[]; skipped: string[] }> {
  if (!fs.existsSync(dir)) return { contents: [], skipped: [] };
  const names = (await fsp.readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  const results = await Promise.all(
    names.map(async (f) => ({ name: f, text: await readFileOrSkip(path.join(dir, f)) })),
  );
  return {
    contents: results.map((r) => r.text).filter((text): text is string => Boolean(text)),
    skipped: results.filter((r) => r.text === null).map((r) => r.name),
  };
}

/**
 * Assemble the system prompt from framework and user instruction files.
 * Framework content comes first, user content appended after.
 * `prompt` is undefined if no content was found in either directory;
 * `skipped` names files that existed but could not be read.
 */
export async function assemblePrompt(
  frameworkDir: string,
  instructionsDir: string,
): Promise<{ prompt: string | undefined; skipped: string[] }> {
  const framework = await readMarkdownFiles(frameworkDir);
  const user = await readMarkdownFiles(instructionsDir);
  const skipped = [...framework.skipped, ...user.skipped];

  if (framework.contents.length === 0 && user.contents.length === 0) {
    return { prompt: undefined, skipped };
  }

  const parts: string[] = [];

  if (framework.contents.length > 0) {
    parts.push(framework.contents.join("\n\n---\n\n"));
  }

  if (user.contents.length > 0) {
    parts.push(user.contents.join("\n\n---\n\n"));
  }

  return { prompt: parts.join("\n\n"), skipped };
}
