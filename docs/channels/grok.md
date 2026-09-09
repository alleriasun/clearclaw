# Grok channel

ClearClaw Channel adapter for the Grok Bot host HTTP gateway (undocumented; accepted). Telegram and Slack stay the human chat surfaces; Grok is an optional visibility / Chief-of-Staff front door selected when those tokens are unset.

One channel per instance (same as Telegram vs Slack). Priority: Slack, then Telegram, then Grok.

## Topology

```
ClearClaw GrokChannel (Mini) --Tailscale/SSH--> Grok gateway :1340
  --sendPrompt(ClearClaw seat)--> transcript/events back --> Channel.emit message
```

Reach the host over a tailnet or SSH tunnel. Do not publish port 1340.

## Env

| Variable | Role |
| --- | --- |
| `GROKBOT_GATEWAY_URL` or `SAND_GATEWAY_URL` | Base URL, e.g. `http://<host>:1340` |
| `SAND_GATEWAY_TOKEN` | Bearer token from the Grok box `gateway.json`. Never commit or log it. |
| `GROK_RELAY_AGENT_ID` | Bound seat. Default `53f49e93-8c14-4c1c-8748-0df28ccbaf69`. |

`ALLOWED_USER_IDS` is still required by the daemon. The gateway token is the Grok trust boundary; inbound assistant entries are emitted as `origin.user.id = grok:<agentId>`. Pairing DMs are not used.

## chat_id

- `grok:<agentUuid>` — canonical workspace binding and inbound `chatId`
- `grok:default` — outbound alias for `GROK_RELAY_AGENT_ID`

`ownsId` is `chatId.startsWith("grok:")`.

## Mapping

| Channel | Gateway |
| --- | --- |
| `connect` | `GET /health` (unauth), `GET /events` (SSE, auth), `getAgentTranscriptTail` snapshot + poller |
| `disconnect` | abort SSE and pollers |
| `sendMessage` | `POST /api/sendPrompt` `{ agentId, prompt, replyToId?, clientNonce }` |
| `sendInteractive` | `respondToWidget` if a widget entry is pending; else `sendPrompt` |
| `reactToMessage` | `POST /api/reactToMessage` `{ entryId, emoji, agentId }` |
| `interrupt` (`/cancel`) | `POST /api/interruptAgentRun` `{ id }` |
| `setTyping`, `updateStatus`, `editMessage`, `deleteMessage`, `pinMessage`, `unpinAllMessages` | **no-ops** (no host analogue in the v1 map) |
| `sendFile` | **stub** — host has `uploadAttachment` but no typed body; do not invent multipart vs path |

Inbound: new **assistant** transcript rows (after the connect snapshot) emit `InboundMessage`. Dedup is by entry id / seq. User-role rows (including our own `sendPrompt` echoes) are not emitted. SSE payloads are liveness/busy only — not chat text.

## Caveats

- The gateway is an undocumented internal API. Command names follow the live host / community SDK (`SAND_GATEWAY_COMMANDS`); there is no host `sendToAgent`.
- Tail polling uses `getAgentTranscriptTail` (does not switch the host's active agent). `openAgentTail` is unused on purpose.
- Interactive buttons have no Grok callback. `sendInteractive` returns `{ value: "" }` (timeout semantics) after posting.
- Workspace `chat_id` should be `grok:<uuid>`, not the `default` alias, so inbound routing matches.

See [grok-channel-spec.md](grok-channel-spec.md) for the contract one-pager.
