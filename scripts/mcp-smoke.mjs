// MCP stdio smoke test.  node scripts/mcp-smoke.mjs        → initialize + tools/list + status
//                        node scripts/mcp-smoke.mjs --live → also runs example questions (needs sign-in)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes('--live');
const p = spawn(process.execPath, [join(here, '..', 'bin', 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; const got = new Map(); let nextId = 1;
p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { const m = JSON.parse(line); if (m.id != null) got.set(m.id, m); } } });
p.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
const call = (method, params, timeoutMs = 60_000) => new Promise((resolve, reject) => {
  const id = nextId++; send({ jsonrpc: '2.0', id, method, params });
  const t0 = Date.now(); const iv = setInterval(() => { if (got.has(id)) { clearInterval(iv); resolve({ ...got.get(id), ms: Date.now() - t0 }); } else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error(`timeout ${method}`)); } }, 50);
});
const tool = async (name, args) => { const r = await call('tools/call', { name, arguments: args }); const txt = r.result?.content?.[0]?.text || ''; return { ms: r.ms, isError: r.result?.isError, text: txt }; };
const show = (label, r, n = 400) => console.log(`\n== ${label} (${r.ms} ms${r.isError ? ', ERROR' : ''})\n${r.text.slice(0, n)}${r.text.length > n ? ' …' : ''}`);

await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
const tools = (await call('tools/list', {})).result.tools;
console.log('tools:', tools.map((t) => t.name).join(', '));
show('status', await tool('altea_status', {}), 300);
if (live) {
  show('who teaches on Monday (first name from the schedule)', await (async () => { const s = await tool('altea_schedule', { date: 'mon', group: 'all', format: 'detailed', limit: 200 }); const first = ((s.s?.days?.[0]?.events || []).flatMap((e) => e.instructors || []).find(Boolean) || 'x').split(' ')[0]; return tool('altea_instructor', { name: first, date: 'mon' }); })(), 900);
  show('next hot yin', await tool('altea_next', { query: 'hot yin' }), 900);
  show('pickleball courts tomorrow at 3pm', await tool('altea_schedule', { date: 'tomorrow', group: 'pickleball', at: '3pm', availableOnly: true }), 900);
  const c1 = await call('tools/call', { name: 'altea_schedule', arguments: { date: 'tomorrow' } });
  const c2 = await call('tools/call', { name: 'altea_schedule', arguments: { date: 'tomorrow', format: 'detailed' } });
  const size = (r) => ({ text: r.result?.content?.[0]?.text?.length ?? 0, structured: JSON.stringify(r.result?.structuredContent ?? {}).length });
  console.log(`\n== size: concise ${JSON.stringify(size(c1))} vs detailed ${JSON.stringify(size(c2))} (chars)`);
  const far = await tool('altea_schedule', { date: '+4', availableOnly: true, format: 'detailed', limit: 1 }); const farId = (far.text.match(/\((evt_[A-Za-z0-9_]+)\)/) || [])[1];
  if (farId) show('window guard (4 days out)', await tool('altea_book', { eventId: farId }), 300);
  show('resource altea://rules', { ms: 0, text: (await call('resources/read', { uri: 'altea://rules' })).result?.contents?.[0]?.text || '' }, 300);
}
p.kill();
