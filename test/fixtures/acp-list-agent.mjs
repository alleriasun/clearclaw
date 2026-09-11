import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const mode = process.env.LIST_MODE;
const log = (data) => appendFileSync(process.env.LIST_LOG, JSON.stringify(data) + '\n');
const send = (data) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...data }) + '\n');
log({ pid: process.pid });
process.on('SIGTERM', () => { log({ stopped: true }); process.exit(0); });
createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  log(req);
  if (req.method === 'initialize') {
    if (mode === 'hang-init') return;
    return send({ id: req.id, result: { protocolVersion: 1, agentCapabilities: mode === 'unsupported' ? {} : { sessionCapabilities: { list: {} } } } });
  }
  if (req.method !== 'session/list') return send({ id: req.id, error: { code: -32601, message: 'Listing must not load or prompt' } });
  if (mode === 'hang') return;
  if (mode === 'exit') return process.exit(4);
  if (mode === 'error') return send({ id: req.id, error: { code: -32000, message: 'Listing failed' } });
  if (mode === 'empty') return send({ id: req.id, result: { sessions: [] } });
  if (mode === 'repeat') return send({ id: req.id, result: { sessions: [], nextCursor: 'same' } });
  const cwd = req.params.cwd;
  const session = (id, day, title = `Session ${id}`) => ({ sessionId: id, cwd, title, updatedAt: `2026-09-${day}T00:00:00Z` });
  if (mode === 'late-newest') return send({ id: req.id, result: req.params.cursor
    ? { sessions: [session('late-newest', '11')] }
    : { sessions: Array.from({ length: 10 }, (_, i) => session(`old-${i}`, '08')), nextCursor: 'later' } });
  if (mode === 'missing') return send({ id: req.id, result: { sessions: [
    { sessionId: 'no-title', cwd }, { sessionId: 'blank-title', cwd, title: '  ', updatedAt: 'invalid' },
    session('dated', '10', 'Known date'),
  ] } });
  if (!req.params.cursor) return send({ id: req.id, result: { sessions: [
    session('older', '08'), session('newest', '11'), { ...session('sibling', '11'), cwd: cwd + '-sibling' },
  ], nextCursor: 'page2' } });
  if (req.params.cursor === 'page2') return send({ id: req.id, result: { sessions: [], nextCursor: 'page3' } });
  send({ id: req.id, result: { sessions: [session('older', '08'), ...Array.from({ length: 11 }, (_, i) => session(`more-${i}`, '09'))] } });
});
