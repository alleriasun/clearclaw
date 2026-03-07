import { loadConfig } from "./config.js";
import log from "./logger.js";
import {
  initDb,
  getWorkspaceByChannel,
  upsertWorkspace,
  updateSessionId,
  clearSession,
} from "./db.js";
import { ClaudeCodeEngine } from "./engine/claude-code.js";
import { TelegramChannel } from "./channel/telegram.js";
import { formatToolUse, formatToolResult } from "./format.js";

const DEFAULT_WORKSPACE = "main";

async function main() {
  const config = loadConfig();
  initDb();

  const channelId = `tg:${config.allowedChatId}`;

  // Seed default workspace if it doesn't exist
  if (!getWorkspaceByChannel(channelId)) {
    upsertWorkspace({
      name: DEFAULT_WORKSPACE,
      cwd: config.defaultCwd,
      channel_id: channelId,
      current_session_id: null,
    });
  }

  const engine = new ClaudeCodeEngine();
  let busy = false;

  const telegram = new TelegramChannel(
    config.botToken,
    config.allowedChatId,
    {
      onMessage: async (msg) => {
        try {
          log.info(`[msg] ${msg.text.slice(0, 80)}`);

          // /new — reset session
          if (msg.text === "/new") {
            clearSession(DEFAULT_WORKSPACE);
            log.info("[cmd] session cleared");
            await telegram.sendMessage(msg.channelId, "Session cleared.");
            return;
          }

          // Reject during active turn
          if (busy) {
            log.info("[msg] rejected (busy)");
            await telegram.sendMessage(
              msg.channelId,
              "Still working on the previous message...",
            );
            return;
          }

          busy = true;
          const ws = getWorkspaceByChannel(msg.channelId);
          if (!ws) {
            log.info("[msg] no workspace for channel %s", msg.channelId);
            busy = false;
            return;
          }

          log.info(`[turn] start session=${ws.current_session_id ?? "new"} cwd=${ws.cwd}`);
          await telegram.setTyping(msg.channelId, true);

          try {
            let fullText = "";
            for await (const event of engine.runTurn({
              sessionId: ws.current_session_id,
              cwd: ws.cwd,
              prompt: msg.text,
              permissionMode: config.permissionMode,
              onPermissionRequest: async (req) => {
                if (fullText) {
                  await telegram.sendMessage(msg.channelId, fullText);
                  fullText = "";
                }
                log.info(`[perm] ${req.toolName}`);
                const resp = await telegram.sendInteractive(
                  msg.channelId,
                  `Allow ${req.toolName}?`,
                  [
                    { label: "Allow", value: "allow" },
                    { label: "Deny", value: "deny" },
                  ],
                );
                log.info(`[perm] ${req.toolName} → ${resp.value || "timeout"}`);
                return {
                  decision: resp.value === "allow" ? "allow" : "deny",
                };
              },
            })) {
              if (event.type === "text") fullText += event.text;
              if (event.type === "tool_use") {
                const formatted = formatToolUse(event.toolName, event.input);
                await telegram.sendMessage(msg.channelId, formatted, {
                  parseMode: "MarkdownV2",
                });
              }
              if (event.type === "tool_result") {
                const formatted = formatToolResult(event.toolName, event.output);
                if (formatted) {
                  if (fullText) {
                    await telegram.sendMessage(msg.channelId, fullText);
                    fullText = "";
                  }
                  await telegram.sendMessage(msg.channelId, formatted, {
                    parseMode: "MarkdownV2",
                  });
                }
              }
              if (event.type === "done") {
                log.info(`[turn] done session=${event.sessionId}`);
                updateSessionId(DEFAULT_WORKSPACE, event.sessionId);
              }
              if (event.type === "error") {
                log.error(`[turn] error: ${event.message}`);
                await telegram.sendMessage(
                  msg.channelId,
                  `Error: ${event.message}`,
                );
              }
            }
            if (fullText) {
              log.info(`[turn] sending ${fullText.length} chars`);
              await telegram.sendMessage(msg.channelId, fullText);
            } else {
              log.info("[turn] no text to send");
            }
          } finally {
            busy = false;
            await telegram.setTyping(msg.channelId, false);
          }
        } catch (err) {
          log.error({ err }, "[fatal]");
          await telegram.sendMessage(
            msg.channelId,
            `Internal error: ${err instanceof Error ? err.message : String(err)}`,
          ).catch(() => {});
        }
      },
    },
  );

  await telegram.connect();
  log.info("ClearClaw ready.");

  const shutdown = async () => {
    await telegram.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.fatal({ err }, "Fatal");
  process.exit(1);
});
