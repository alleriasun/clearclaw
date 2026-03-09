#!/usr/bin/env node
import { loadConfig } from "./config.js";
import log, { initLogger } from "./logger.js";
import { WorkspaceStore } from "./workspace-store.js";
import { ClaudeCodeEngine } from "./engine/claude-code.js";
import { TelegramChannel } from "./channel/telegram.js";
import { Orchestrator } from "./orchestrator.js";

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
  });

  await orchestrator.start();
}

main().catch((err) => {
  log.fatal({ err }, "Fatal");
  process.exit(1);
});
