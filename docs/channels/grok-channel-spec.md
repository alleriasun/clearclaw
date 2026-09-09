# GrokChannel spec

Status: accepted (v1 stub). The Grok Bot HTTP gateway is undocumented; this map is accepted as-is.

## Topology

ClearClaw GrokChannel (Mini) --Tailscale--> Grok gateway :1340 --sendPrompt(ClearClaw seat)--> transcript/events back --> Channel.emit message.

Telegram stays the primary human channel; Grok is an optional visibility / CoS front door. ClearClaw still runs one Channel per process: Slack, else Telegram, else Grok.

## Auth

Bearer from `SAND_GATEWAY_TOKEN`; never log or commit. Health on connect (`GET /health`, unauth, `{ok:true}`). Base URL from `GROKBOT_GATEWAY_URL` / `SAND_GATEWAY_URL` (`http://<host>:1340`).

## chat_id

`grok:<agentUuid>` or `grok:default` → `GROK_RELAY_AGENT_ID` (default `53f49e93-8c14-4c1c-8748-0df28ccbaf69`).

## Gateway surfaces

- `GET /health` (unauth)
- `GET /events` (SSE, auth) — liveness/busy; not chat text
- `POST /api/<command>` (auth)

Core commands: `sendPrompt`, `getAgentTranscript` / `getAgentTranscriptPage|Window|Tail`, `openAgentTail` / `openAgentWindowed`, `interruptAgentRun`, `respondToWidget` / `dismissWidget`, `reactToMessage`, `listAgents`. No host `sendToAgent`.

v1 uses a thin `fetch` wrapper (no grokbot-sdk / Node 22-only client).

## Channel ↔ gateway map

Outbound:

- connect → health + SSE `/events` + transcript tail poller for bound agent(s)
- disconnect → close SSE/pollers
- sendMessage → `sendPrompt` with agentId parsed from `grok:<uuid>` (or relay id for `grok:default`)
- sendInteractive → `respondToWidget` if answering a widget entry; else `sendPrompt`
- reactToMessage → gateway `reactToMessage`
- interrupt / Orchestrator `/cancel` → `interruptAgentRun`
- setTyping / updateStatus / edit / delete / pin → documented no-ops
- sendFile → stub (uploadAttachment exists on the host; body contract not typed)

Inbound:

- poll/tail new assistant transcript entries → emit `{ chatId: "grok:<agentId>", messageId: entry.id, text: content }`
- dedup by seq/entry id; ignore own echoes when possible
- SSE for liveness/busy only

`ownsId`: `chatId.startsWith("grok:")`
