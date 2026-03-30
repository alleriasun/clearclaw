# In-Process MCP Server — send_file

## Context

ClearClaw needs tools that run in its process with channel access — things the CLI can't do alone, like sending files back to chat. The Claude Agent SDK's `createSdkMcpServer()` creates an in-process MCP server: no child process, no HTTP, no IPC. Tool handlers are JS functions the SDK calls directly. The LLM sees them as ordinary tools (`mcp__clearclaw__send_file`).

First tool on the shared layer's surface. Adding memory/voice tools later = adding to the tools array.

## How createSdkMcpServer works

`createSdkMcpServer({ name, tools })` returns `McpSdkServerConfigWithInstance` — a config object with a live `McpServer` instance (just a JS object, not a process). Pass to `query()` via `options.mcpServers`. SDK calls tool handlers via in-memory function dispatch. Zero overhead to create per-turn.

```typescript
const server = createSdkMcpServer({
  name: "clearclaw",
  tools: [tool("send_file", "...", schema, handler)],
});
query({ prompt, options: { mcpServers: { clearclaw: server } } });
// LLM sees mcp__clearclaw__send_file
```

## Design

### send_file tool

**Inputs (Zod):** `file_path` (optional) OR `data`+`filename` (base64), plus optional `caption`. Either file_path or data must be provided.

**Handler:** Read/decode → determine filename → `channel.sendFile(chatId, buffer, name, { caption })` → return confirmation.

**Created in:** `orchestrator.ts` `handleMessage()`. Closures capture `this.channel` and `msg.chatId`.

### Channel.sendFile — MIME-based platform dispatch

New Channel method: `sendFile(chatId, buffer, filename, opts?)`. Uses `mime` library for extension→MIME lookup.

**Telegram:** image→sendPhoto, video→sendVideo, audio→sendAudio, else→sendDocument.
**Slack:** `files.uploadV2` for everything (auto-previews).

### Wiring

1. `types.ts` — add `mcpServers?: Record<string, McpServerConfig>` to RunTurnOpts
2. `claude-code.ts` — pass `mcpServers` to `query()` options
3. `orchestrator.ts` — create server, pass via RunTurnOpts

### Auto-allow

In `onPermissionRequest`: `if (req.toolName.startsWith("mcp__clearclaw__")) return { decision: "allow" }`

### Dependencies

Add `zod`. Not needed: `@modelcontextprotocol/sdk` (re-exported from agent SDK).

## ACP future path (not in scope)

`McpServer` supports pluggable transports. Same tool defs over stdio/HTTP for ACP. Tool schemas are transport-agnostic; handler context access differs. Refactor when needed.

## Files

- `src/types.ts` — `sendFile` on Channel, `SendFileOpts`, `mcpServers` on RunTurnOpts
- `src/channel/telegram.ts` — `sendFile` with MIME dispatch
- `src/channel/slack.ts` — `sendFile` via `files.uploadV2`
- `src/engine/claude-code.ts` — pass `mcpServers` to `query()`
- `src/orchestrator.ts` — create MCP server, `send_file` tool, auto-allow
- `package.json` — add `zod`
