#!/usr/bin/env node
import { loadConfig } from "./config.js";
import log, { initLogger } from "./logger.js";
import { WorkspaceStore } from "./workspace-store.js";
import { ClaudeCodeEngine } from "./engine/claude-code.js";
import { TelegramChannel } from "./channel/telegram.js";
import { Orchestrator } from "./orchestrator.js";

// The Claude Agent SDK has a bug: handleControlRequest() writes to the
// subprocess stdin without a .catch(), so aborting during a permission
// callback causes an unhandled rejection (write to dead process).
// Suppress that specific error so we can use abort for deny + /cancel.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (
    msg.includes("Operation aborted") ||
    msg.includes("Failed to write to process stdin") ||
    msg.includes("Cannot write to terminated process")
  ) {
    log.warn("[sdk] suppressed write error (known SDK bug): %s", msg);
    return;
  }
  log.fatal({ err: reason }, "Unhandled rejection");
  process.exit(1);
});

async function main() {
  const config = loadConfig();
  initLogger(config.logPath);
  const workspaceStore = new WorkspaceStore(config.workspacesPath);

  const channel = new TelegramChannel(config.botToken, config.allowedUserId);
  const engine = new ClaudeCodeEngine();

  const orchestrator = new Orchestrator({
    channel,
    engine,
    workspaceStore,
    permissionMode: config.permissionMode,
    defaultPromptPath: config.defaultPromptPath,
  });

  await orchestrator.start();
}

main().catch((err) => {
  log.fatal({ err }, "Fatal");
  process.exit(1);
});
