import assert from "node:assert/strict";
import test from "node:test";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { serveMcpOverHttp } from "../src/engine/mcp-http.js";

async function fixture(workspace: string) {
  const calls: string[] = [];
  const sdkServer = createSdkMcpServer({
    name: "clearclaw",
    tools: [tool("remember", "Remember a value in the current workspace", {
      value: z.string(),
    }, async ({ value }) => {
      if (value === "fail") throw new Error("Fixture tool failure");
      calls.push(value);
      return { content: [{ type: "text", text: `${workspace}:${value}` }] };
    })],
  });
  const bridge = await serveMcpOverHttp("clearclaw", sdkServer);
  assert.ok("type" in bridge.config && bridge.config.type === "http");
  const { url, headers: descriptorHeaders } = bridge.config;
  const headers = Object.fromEntries(descriptorHeaders.map(({ name, value }) => [name, value]));
  const client = new Client({ name: "clearclaw-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
  return { bridge, client, transport, url, headers, calls };
}

test("HTTP bridge exposes the SDK tool schema, closure, validation, and errors", async (t) => {
  const f = await fixture("workspace-a");
  t.after(async () => {
    await f.client.close();
    await f.bridge.close();
  });
  await f.client.connect(f.transport);

  const { tools } = await f.client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "remember");
  assert.equal(tools[0].description, "Remember a value in the current workspace");
  assert.deepEqual(tools[0].inputSchema.required, ["value"]);

  const result = await f.client.callTool({ name: "remember", arguments: { value: "hello" } });
  assert.deepEqual(result.content, [{ type: "text", text: "workspace-a:hello" }]);
  assert.deepEqual(f.calls, ["hello"]);

  const invalid = await f.client.callTool({ name: "remember", arguments: { value: 123 } });
  assert.equal(invalid.isError, true);
  assert.deepEqual(f.calls, ["hello"], "schema validation must run before the handler");

  const failed = await f.client.callTool({ name: "remember", arguments: { value: "fail" } });
  assert.equal(failed.isError, true);
  assert.match(JSON.stringify(failed.content), /Fixture tool failure/);
});

test("HTTP bridge rejects missing and wrong credentials, and closing revokes access", async (t) => {
  const f = await fixture("workspace-a");
  t.after(() => f.bridge.close());
  assert.equal(new URL(f.url).hostname, "127.0.0.1");
  for (const headers of [{}, { Authorization: "Bearer wrong" }]) {
    const response = await fetch(f.url, { method: "POST", headers });
    assert.equal(response.status, 401);
    await response.arrayBuffer();
  }
  assert.deepEqual(f.calls, []);

  const missingPath = await fetch(`${f.url}/missing`, { headers: f.headers });
  assert.equal(missingPath.status, 404);
  await missingPath.arrayBuffer();
  await f.bridge.close();
  await assert.rejects(fetch(f.url, { headers: f.headers }));
});

test("concurrent HTTP bridges retain separate workspace handlers and credentials", async (t) => {
  const a = await fixture("workspace-a");
  t.after(async () => { await a.client.close(); await a.bridge.close(); });
  const b = await fixture("workspace-b");
  t.after(async () => { await b.client.close(); await b.bridge.close(); });
  await Promise.all([a.client.connect(a.transport), b.client.connect(b.transport)]);

  const [resultA, resultB] = await Promise.all([
    a.client.callTool({ name: "remember", arguments: { value: "first" } }),
    b.client.callTool({ name: "remember", arguments: { value: "second" } }),
  ]);
  assert.deepEqual(resultA.content, [{ type: "text", text: "workspace-a:first" }]);
  assert.deepEqual(resultB.content, [{ type: "text", text: "workspace-b:second" }]);
  assert.deepEqual(a.calls, ["first"]);
  assert.deepEqual(b.calls, ["second"]);

  const crossWorkspace = await fetch(b.url, { method: "POST", headers: a.headers });
  assert.equal(crossWorkspace.status, 401);
  await crossWorkspace.arrayBuffer();
});
