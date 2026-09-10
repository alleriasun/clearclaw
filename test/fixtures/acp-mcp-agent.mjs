import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [mode, tracePath] = process.argv.slice(2);
const record = (event) => appendFileSync(tracePath, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
const hang = () => new Promise(() => {});
let servers = [];
let setupMethod;
const modelSelector = {
  id: "fixture-model-selector", name: "Model", category: "model", type: "select",
  currentValue: "default-model", options: [{ value: "fixture-model", name: "Fixture Model" }],
};

async function setup(method, params) {
  servers = params.mcpServers;
  setupMethod = method;
  record({ phase: "setup", method, servers });
  if (mode === "hang-load") return hang();
  if (mode === "fail-setup") throw new Error("Fixture setup failure");
  if (mode === "exit-setup") process.exit(7);
  return { ...(method === "new" ? { sessionId: "fixture-session" } : {}), configOptions: [modelSelector] };
}

new AgentSideConnection((connection) => ({
  async initialize() {
    record({ phase: "initialize" });
    if (mode === "hang-initialize") return hang();
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: mode !== "unsupported" } },
    };
  },
  newSession: (params) => setup("new", params),
  loadSession: (params) => setup("load", params),
  async setSessionConfigOption(params) {
    record({ phase: "model", ...params });
    if (mode === "reject-model") throw new RequestError(-32602, "Fixture rejected model");
    return { configOptions: [{ ...modelSelector, currentValue: params.value }] };
  },
  async prompt({ sessionId }) {
    record({ phase: "prompt", sessionId });
    if (mode === "hang-prompt") return hang();
    let result = { content: [] };
    if (servers.length) {
      const server = servers[0];
      const client = new Client({ name: "fixture-agent", version: "1.0.0" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) },
        }));
        result = await client.callTool({ name: "turn_context", arguments: {} });
      } finally {
        await client.close();
      }
    }
    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: JSON.stringify({ method: setupMethod, result }) },
      },
    });
    await connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "usage_update", used: 250, size: 2000 },
    });
    return { stopReason: "end_turn" };
  },
  async cancel() {},
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
