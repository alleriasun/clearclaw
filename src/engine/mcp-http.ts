import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import log from "../logger.js";

/** A turn-scoped HTTP endpoint in front of one in-process MCP server. */
export interface McpBridge {
  config: McpServer;
  close(): Promise<void>;
}

/** Expose the turn's existing handlers to a subprocess, without another tool process. */
export async function serveMcpOverHttp(name: string, server: McpSdkServerConfigWithInstance): Promise<McpBridge> {
  const authorization = `Bearer ${randomBytes(32).toString("hex")}`;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  const http = createServer((req, res) => {
    if (req.headers.authorization !== authorization) {
      res.writeHead(401).end();
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    transport.handleRequest(req, res).catch((err) => {
      log.error({ err }, "[mcp] HTTP transport failed");
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const close = async () => {
    // Stop accepting requests before closing MCP streams and keep-alive sockets.
    const closed = new Promise<void>((resolve) => http.close(() => resolve()));
    http.closeAllConnections();
    await server.instance.close();
    await closed;
  };

  try {
    await server.instance.connect(transport);
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", () => {
        http.off("error", reject);
        resolve();
      });
    });
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("MCP HTTP listener has no address");
    return {
      config: {
        type: "http",
        name,
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: [{ name: "Authorization", value: authorization }],
      },
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}
