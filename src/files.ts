import crypto from "node:crypto";
import fs from "node:fs/promises";
import mime from "mime";
import path from "node:path";
import type { Attachment } from "./types.js";

/** Save an attachment to disk for audit logging. Returns the saved file path. */
export async function saveFile(
  att: Attachment,
  workspace: string,
  filesPath: string,
): Promise<string> {
  const epoch = Math.floor(Date.now() / 1000);
  const hex = crypto.randomBytes(2).toString("hex");
  const name = att.filename
    ? sanitizeFilename(att.filename)
    : `file${att.mimeType ? `.${mime.getExtension(att.mimeType) ?? "bin"}` : ""}`;
  const filename = `${workspace}-${epoch}-${hex}-${name}`;
  const filePath = path.join(filesPath, filename);

  await fs.writeFile(filePath, att.buffer);

  return filePath;
}

/** Strip path separators and null bytes, collapse whitespace. */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\\0]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 200);
}
