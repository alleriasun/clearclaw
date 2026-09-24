import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (entry) => appendFileSync(process.env.ENGINE_PATH_LOG, JSON.stringify(entry) + "\n");
log({ executable: process.argv[1], args: process.argv.slice(2), config: process.env.CODEX_CONFIG });
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  log({ method: request.method });
  if (request.id === undefined) return;
  if (request.method === "initialize" && process.env.ENGINE_PATH_FAIL_INIT === "1") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Launch environment recorded" } }) + "\n");
    return;
  }
  let result;
  switch (request.method) {
    case "initialize":
      result = process.argv[2] === "acp"
        ? { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } } }
        : { userAgent: "executable-path-fixture", codexHome: process.env.CODEX_HOME };
      break;
    case "account/read":
      result = { account: null, requiresOpenaiAuth: false };
      break;
    case "session/list":
      result = { sessions: [{ sessionId: "configured-cli", cwd: request.params.cwd, title: "Configured CLI" }] };
      break;
    case "thread/list":
      result = { data: [{ id: "configured-cli", cwd: process.env.ENGINE_PATH_CWD, preview: "Configured CLI", updatedAt: 1 }], nextCursor: null };
      break;
    default:
      process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32601, message: `Unexpected ${request.method}` } }) + "\n");
      return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
