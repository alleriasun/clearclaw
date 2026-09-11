import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const [mode, tracePath] = process.argv.slice(2);
const log = (data) => appendFileSync(tracePath, JSON.stringify(data) + '\n');
const send = (data) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...data }) + '\n');
log({ pid: process.pid });
const selector = {
  id: mode === 'uncategorized' ? 'model' : 'custom-model-selector', name: 'Model', type: 'select',
  ...(mode === 'uncategorized' ? {} : { category: 'model' }),
  currentValue: 'default-model', options: [{ value: 'fixture-model', name: 'Fixture Model' }],
};
const config = mode === 'no-config' ? {} : { configOptions: mode === 'unrelated-config'
  ? [{ ...selector, id: 'mode', category: 'mode', name: 'Mode' }] : [selector] };

createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  log({ method: req.method, params: req.params });
  if (req.method === 'initialize') {
    send({ id: req.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  } else if (req.method === 'session/new') {
    send({ id: req.id, result: { sessionId: 'fixture-session', ...config } });
  } else if (req.method === 'session/load') {
    selector.currentValue = 'resumed-model';
    send({ method: 'session/update', params: { sessionId: req.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'History replay' } } } });
    if (mode.startsWith('usage-')) send({ method: 'session/update', params: {
      sessionId: req.params.sessionId, update: { sessionUpdate: 'usage_update', used: 800, size: 1000 },
    } });
    if (mode === 'quota') send({ method: 'session/update', params: {
      sessionId: req.params.sessionId, update: { sessionUpdate: 'usage_update', used: 800, size: 1000,
        _meta: { '_codex/rateLimits': [{ limitId: 'codex', primary: { usedPercent: 99, windowDurationMins: 300 } }] } },
    } });
    send({ id: req.id, result: config });
  } else if (req.method === 'session/set_config_option') {
    if (mode === 'reject-model') return send({ id: req.id, error: { code: -32000, message: 'Fixture rejected model' } });
    send({ id: req.id, result: { configOptions: [{ ...selector, currentValue: 'selected-model' }] } });
  } else if (req.method === 'session/prompt') {
    if (mode === 'model-update') send({ method: 'session/update', params: {
      sessionId: req.params.sessionId, update: { sessionUpdate: 'config_option_update',
        configOptions: [{ ...selector, currentValue: 'updated-model' }] },
    } });
    send({ method: 'session/update', params: { sessionId: req.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Model answered' } } } });
    if (mode === 'usage-live' || mode === 'usage-zero') {
      for (const used of [600, mode === 'usage-zero' ? 0 : 250]) {
        send({ method: 'session/update', params: { sessionId: req.params.sessionId,
          update: { sessionUpdate: 'usage_update', used, size: 2000 } } });
      }
    }
    if (mode === 'quota') send({ method: 'session/update', params: {
      sessionId: req.params.sessionId, update: { sessionUpdate: 'usage_update', used: 250, size: 1000,
        _meta: { '_codex/rateLimits': [{ limitId: 'codex', primary: { usedPercent: 47, windowDurationMins: 300 },
          secondary: { usedPercent: 18, windowDurationMins: 10080 } }] } },
    } });
    send({ id: req.id, result: { stopReason: 'end_turn' } });
  } else if (req.id !== undefined) {
    send({ id: req.id, error: { code: -32601, message: 'Unexpected request' } });
  }
});
