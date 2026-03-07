import { loadConfig } from "./config.js";
import { initDb } from "./db.js";
import { ClaudeCodeEngine } from "./engine/claude-code.js";
import { TelegramChannel } from "./channel/telegram.js";
import { Orchestrator } from "./orchestrator.js";
import log from "./logger.js";

async function main() {
  const config = loadConfig();
  initDb();

  const channel = new TelegramChannel(config.botToken, config.allowedUserId);
  const engine = new ClaudeCodeEngine();

  const orchestrator = new Orchestrator({
    channel,
    engine,
    permissionMode: config.permissionMode,
  });

  await orchestrator.start();
}

main().catch((err) => {
  log.fatal({ err }, "Fatal");
  process.exit(1);
});
