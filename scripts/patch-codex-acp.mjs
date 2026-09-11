import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { applyPatch } from "diff";

// Temporary backport of codex-acp PR #334. Fail closed if the bundled source changes.
const version = "1.11.0";
const originalHash = "3527bdaf90a219175c742576963e6d9e943e4ea5fbdbc3e04e7f57f9a9e11343";
const patchedHash = "cc77d2f7132470d1484be379ba2a565c603acb242877dc14aa87b9e8a27328ca";
const hash = (source) => createHash("sha256").update(source).digest("hex");
const require = createRequire(import.meta.url);
const entry = require.resolve("@agentclientprotocol/codex-acp");
const pkg = JSON.parse(readFileSync(resolve(dirname(entry), "../package.json"), "utf8"));
if (pkg.version !== version) {
  throw new Error(`Expected codex-acp ${version}, found ${pkg.version}. Review the usage metadata patch before upgrading.`);
}

const source = readFileSync(entry, "utf8");
const sourceHash = hash(source);
if (sourceHash !== patchedHash) {
  if (sourceHash !== originalHash) {
    throw new Error(`Unexpected codex-acp ${version} bundle. Refusing to patch ${entry}.`);
  }
  const patch = readFileSync(new URL("../patches/codex-acp-1.11.0.patch", import.meta.url), "utf8");
  const patched = applyPatch(source, patch);
  if (patched === false || hash(patched) !== patchedHash) {
    throw new Error("codex-acp usage metadata patch failed verification.");
  }
  writeFileSync(entry, patched);
}
console.log(`codex-acp ${version}: usage metadata patch verified`);
