import fsp from "node:fs/promises";
import path from "node:path";
import log from "./logger.js";

// A cloud-synced instructions dir (OneDrive/iCloud "dataless" placeholder) can
// block a read indefinitely. Reading it synchronously froze the whole relay.
const READ_TIMEOUT_MS = 5000;

/** Settle with `op`, or with null once READ_TIMEOUT_MS passes first. */
async function withReadTimeout<T>(op: Promise<T>): Promise<T | null> {
  // ponytail: Promise.race, not AbortSignal — an abort can't interrupt a read
  // already blocked in libuv's threadpool, which is exactly what a
  // cloud-placeholder file does.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Read a file, giving up after READ_TIMEOUT_MS. Returns null on timeout or error. */
async function readFileOrSkip(file: string): Promise<string | null> {
  try {
    const content = await withReadTimeout(fsp.readFile(file, "utf-8"));
    if (content === null) {
      log.warn("[prompt] timed out reading %s after %dms — skipping", file, READ_TIMEOUT_MS);
      return null;
    }
    return content.trim();
  } catch (err) {
    log.warn({ err }, "[prompt] could not read %s — skipping", file);
    return null;
  }
}

/**
 * Read all .md files from a directory, sorted alphabetically.
 * Unreadable files are reported by name instead of silently dropped.
 */
async function readMarkdownFiles(dir: string): Promise<{ contents: string[]; skipped: string[] }> {
  let entries: string[] | null;
  try {
    // Listing a cloud-synced dir can block just like reading one (seen with
    // Google Drive under a launchd daemon before macOS granted access).
    entries = await withReadTimeout(fsp.readdir(dir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { contents: [], skipped: [] };
    // Cloud-synced dirs (Google Drive File Provider) can transiently refuse a listing with EPERM.
    log.warn({ err }, "[prompt] could not list %s — skipping", dir);
    return { contents: [], skipped: [dir] };
  }
  if (entries === null) {
    log.warn("[prompt] timed out listing %s after %dms — skipping", dir, READ_TIMEOUT_MS);
    return { contents: [], skipped: [dir] };
  }
  const names = entries.filter((f) => f.endsWith(".md")).sort();
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
