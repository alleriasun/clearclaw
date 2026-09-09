import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const mode = process.env.HISTORY_MODE;
let loadId;
const log = (data) => appendFileSync(process.env.HISTORY_LOG, JSON.stringify(data) + '\n');
const send = (data) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...data }) + '\n');
log({ pid: process.pid });
process.on('SIGTERM', () => { log({ stopped: true }); process.exit(0); });
createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  log({ method: req.method, params: req.params, result: req.result });
  if (req.id === 90) {
    send({ id: loadId, result: {} });
    return;
  }
  if (req.method === 'initialize') {
    send({ id: req.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: mode !== 'unsupported' }, authMethods: [] } });
  } else if (req.method === 'session/load') {
    loadId = req.id;
    if (mode === 'hang') return;
    if (mode === 'permission') return send({ id: 90, method: 'session/request_permission', params: { sessionId: req.params.sessionId, toolCall: { toolCallId: 'unsafe', title: 'Unwanted operation' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } });
    if (mode === 'exit') return process.exit(4);
    if (mode === 'error') return send({ id: req.id, error: { code: -32000, message: 'Missing session' } });
    const emit = (update, sessionId = req.params.sessionId) => send({ method: 'session/update', params: { sessionId, update } });
    const text = (kind, text, messageId) => emit({ sessionUpdate: kind, content: { type: 'text', text }, ...(messageId ? { messageId } : {}) });
    emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Other session' } }, 'another-session');
    text('user_message_chunk', 'Keep ', 'user-1');
    text('user_message_chunk', 'it simple.', 'user-1');
    text('user_message_chunk', 'And readable.', 'user-2');
    text('agent_thought_chunk', 'Private reasoning');
    text('agent_message_chunk', 'Plain ', 'assistant-1');
    text('agent_message_chunk', 'markdown.', 'assistant-1');
    text('agent_message_chunk', 'Next answer.', 'assistant-2');
    text('user_message_chunk', 'No IDs ');
    text('user_message_chunk', 'still join.');
    send({ id: req.id, result: {} });
  } else send({ id: req.id, error: { code: -32601, message: 'History must not prompt' } });
});
