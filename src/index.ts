import { loadConfig, ensureDataDir } from "./config.js";
import {
  initDb,
  getWorkspaceByChannel,
  upsertWorkspace,
  updateSessionId,
  clearSession,
} from "./db.js";
import { ClaudeCodeEngine } from "./engine/claude-code.js";
import { TelegramChannel } from "./channel/telegram.js";
import { formatToolUse } from "./format.js";

const DEFAULT_WORKSPACE = "main";

async function main() {
  const config = loadConfig();
  ensureDataDir();
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
          console.log(`[msg] ${msg.text.slice(0, 80)}`);

          // /new — reset session
          if (msg.text === "/new") {
            clearSession(DEFAULT_WORKSPACE);
            console.log("[cmd] session cleared");
            await telegram.sendMessage(msg.channelId, "Session cleared.");
            return;
          }

          // Reject during active turn
          if (busy) {
            console.log("[msg] rejected (busy)");
            await telegram.sendMessage(
              msg.channelId,
              "Still working on the previous message...",
            );
            return;
          }

          busy = true;
          const ws = getWorkspaceByChannel(msg.channelId);
          if (!ws) {
            console.log("[msg] no workspace for channel", msg.channelId);
            busy = false;
            return;
          }

          console.log(`[turn] start session=${ws.current_session_id ?? "new"} cwd=${ws.cwd}`);
          await telegram.setTyping(msg.channelId, true);

          try {
            let fullText = "";
            for await (const event of engine.runTurn({
              sessionId: ws.current_session_id,
              cwd: ws.cwd,
              prompt: msg.text,
              permissionMode: config.permissionMode,
              onPermissionRequest: async (req) => {
                // Flush accumulated text before showing permission prompt
                if (fullText) {
                  await telegram.sendMessage(msg.channelId, fullText);
                  fullText = "";
                }
                console.log(`[perm] ${req.description}`);
                const buttons = [
                  { label: "Allow", value: "allow" },
                  { label: "Deny", value: "deny" },
                ];
                const resp = await telegram.sendInteractive(
                  msg.channelId,
                  req.description,
                  buttons,
                );
                console.log(`[perm] ${req.toolName} → ${resp.value || "timeout"}`);
                return {
                  decision: resp.value === "allow" ? "allow" : "deny",
                };
              },
            })) {
              if (event.type === "text") fullText += event.text;
              if (event.type === "tool_use") {
                const formatted = formatToolUse(event.toolName, event.input);
                if (formatted) {
                  // Flush accumulated text before showing diff
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
                console.log(`[turn] done session=${event.sessionId}`);
                updateSessionId(DEFAULT_WORKSPACE, event.sessionId);
              }
              if (event.type === "error") {
                console.log(`[turn] error: ${event.message}`);
                await telegram.sendMessage(
                  msg.channelId,
                  `Error: ${event.message}`,
                );
              }
            }
            if (fullText) {
              console.log(`[turn] sending ${fullText.length} chars`);
              await telegram.sendMessage(msg.channelId, fullText);
            } else {
              console.log("[turn] no text to send");
            }
          } finally {
            busy = false;
            await telegram.setTyping(msg.channelId, false);
          }
        } catch (err) {
          console.error("[fatal]", err);
          await telegram.sendMessage(
            msg.channelId,
            `Internal error: ${err instanceof Error ? err.message : String(err)}`,
          ).catch(() => {});
        }
      },
    },
  );

  await telegram.connect();
  console.log("ClearClaw ready.");

  const shutdown = async () => {
    await telegram.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
