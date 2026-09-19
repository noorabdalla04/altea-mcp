// Live eval: realistic questions through the real MCP server with pass/fail assertions and timings.
//   node scripts/eval.mjs        (needs a signed-in session; exits 1 on any failure)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const p = spawn(process.execPath, [join(here, '..', 'bin', 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; const got = new Map(); let nextId = 1;
p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { const m = JSON.parse(line); if (m.id != null) got.set(m.id, m); } } });
p.stderr.on('data', () => {});
const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
const call = (method, params, timeoutMs = 90_000) => new Promise((resolve, reject) => { const id = nextId++; send({ jsonrpc: '2.0', id, method, params }); const t0 = Date.now(); const iv = setInterval(() => { if (got.has(id)) { clearInterval(iv); resolve({ ...got.get(id), ms: Date.now() - t0 }); } else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error(`timeout ${method}`)); } }, 30); });
const tool = async (name, args) => { const r = await call('tools/call', { name, arguments: args }); return { ms: r.ms, isError: !!r.result?.isError, text: r.result?.content?.[0]?.text || '', s: r.result?.structuredContent }; };

await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'eval', version: '0' } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
const rows = []; let failures = 0;
async function evalCase(name, fn) {
  const t0 = Date.now();
  try { const note = await fn(); rows.push({ name, ok: true, ms: Date.now() - t0, note }); }
  catch (e) { failures++; rows.push({ name, ok: false, ms: Date.now() - t0, note: e.message }); }
}
const nowMs = Date.now();
// Adjust to your club: ALTEA_EVAL_INSTRUCTOR, ALTEA_EVAL_CLASS, ALTEA_EVAL_COURTS (group), ALTEA_EVAL_TYPO
const EV = { instructor: process.env.ALTEA_EVAL_INSTRUCTOR, klass: process.env.ALTEA_EVAL_CLASS || 'hot yin', courts: process.env.ALTEA_EVAL_COURTS || 'courts', typo: process.env.ALTEA_EVAL_TYPO };
if (!EV.instructor) { // pick whoever teaches first on Monday, so no name lives in this file
  const s = await tool('altea_schedule', { date: 'mon', group: 'all', format: 'detailed', limit: 200 });
  const first = (s.s?.days?.[0]?.events || []).flatMap((e) => e.instructors || []).find(Boolean) || 'x';
  EV.instructor = first.split(' ')[0].toLowerCase();
}
if (!EV.typo) EV.typo = EV.instructor.slice(0, -1) + (EV.instructor.endsWith('q') ? 'z' : 'q'); // one wrong letter, not a substring

await evalCase('status: signed in + rules', async () => { const r = await tool('altea_status', {}); if (r.isError || !r.s.signedIn) throw new Error(r.text); if (r.s.rules.cancelWindowMin !== 480 || r.s.rules.bookingWindowMin !== 2880) throw new Error('rules drifted'); return 'ok'; });
await evalCase('Q1 "sessions run by instructor X on Monday"', async () => { const c = await tool('altea_instructor', { name: EV.instructor, date: 'mon' }); if (c.isError) throw new Error(c.text); if (c.s.count < 1) throw new Error('no sessions'); if (!c.s.sessions.every((e) => new RegExp(EV.instructor, 'i').test(e.who || '') && e.date === c.s.from)) throw new Error('concise: wrong who/date'); const r = await tool('altea_instructor', { name: EV.instructor, date: 'mon', format: 'detailed' }); if (!r.s.sessions.every((e) => e.instructors.some((n) => new RegExp(EV.instructor, 'i').test(n)) && e.date === r.s.from)) throw new Error('detailed: wrong instructor/date'); return `${r.s.count} sessions across ${new Set(r.s.sessions.map((e) => e.group)).size} groups`; });
await evalCase('Q2 "spots left in the next Hot Yin"', async () => { const r = await tool('altea_next', { query: EV.klass, format: 'detailed' }); if (r.isError || !r.s.next) throw new Error(r.text); if (!new RegExp(EV.klass, 'i').test(r.s.next.title)) throw new Error('wrong title'); if (Date.parse(r.s.next.start) < nowMs - 3600_000) throw new Error('not in the future'); if (typeof r.s.waitlistedUsers !== 'number' || typeof r.s.bookableNow !== 'boolean') throw new Error('missing waitlist/window'); return `${r.s.next.date} ${r.s.next.time} ${r.s.next.full ? 'FULL' : r.s.next.spotsLeft + ' left'}${r.s.nextWithSpots && !r.s.sameEvent ? `; next with spots ${r.s.nextWithSpots.date} ${r.s.nextWithSpots.time}` : ''}`; });
await evalCase('Q3 "pickleball courts open tomorrow at 3 pm"', async () => { const r = await tool('altea_schedule', { date: 'tomorrow', group: EV.courts, at: '3pm', availableOnly: true, format: 'detailed' }); if (r.isError) throw new Error(r.text); const evs = r.s.days[0].events; if (!evs.length) return 'none open (valid answer)'; if (!evs.every((e) => e.time <= '15:00' && e.end > '15:00' && !e.full)) throw new Error('filter leak'); const c = await tool('altea_schedule', { date: 'tomorrow', group: EV.courts, at: '3pm', availableOnly: true }); if (!c.s.days[0].events.every((e) => typeof e.spots === 'number' && e.spots > 0)) throw new Error('concise: spots missing'); return `${evs.length} courts open`; });
await evalCase('typo → suggestion', async () => { const r = await tool('altea_instructor', { name: EV.typo, date: 'mon' }); if (r.isError) throw new Error(r.text); if (r.s.count !== 0 || !r.s.suggestions.some((x) => new RegExp(EV.instructor, 'i').test(x))) throw new Error('no suggestion'); return r.s.suggestions.join(', '); });
await evalCase('week debrief, all groups, evening band', async () => { const r = await tool('altea_schedule', { date: 'tomorrow', days: 2, group: 'all', timeOfDay: 'evening' }); if (r.isError) throw new Error(r.text); if (!r.s.days.every((d) => d.events.every((e) => e.time >= '18:00' && e.time < '21:00'))) throw new Error('band leak'); return `${r.s.count} events, ${r.s.groups.length} groups`; });
await evalCase('event detail has window + policy', async () => { const f = await tool('altea_find', { query: 'main stage ride', days: 3 }); const id = f.s.events[0]?.id; if (!id) throw new Error('no main stage ride'); const r = await tool('altea_event', { eventId: id }); if (r.isError) throw new Error(r.text); if (!r.s.bookingWindow || !r.s.cancellation || r.s.cancellation.windowHours !== 8) throw new Error('policy missing'); return `${r.s.event.date} ${r.s.event.time} bookableNow=${r.s.bookingWindow.bookableNow}`; });
await evalCase('48 h guard refuses far-out booking (no side effect)', async () => { const s = await tool('altea_schedule', { date: '+4', availableOnly: true }); const id = s.s.days[0].events[0]?.id; if (!id) throw new Error('no event'); const r = await tool('altea_book', { eventId: id }); if (!r.isError || !/ERROR\[WINDOW_NOT_OPEN\]/.test(r.text)) throw new Error(r.text.slice(0, 120)); return 'refused with WINDOW_NOT_OPEN'; });
await evalCase('bookings list renders deadlines', async () => { const r = await tool('altea_bookings', {}); if (r.isError) throw new Error(r.text); if (r.s.bookings.some((b) => b.cancelBy === null && b.status === 'CONFIRMED')) throw new Error('missing deadline'); return `${r.s.count} bookings`; });
await evalCase('bad input → BAD_INPUT', async () => { const r = await tool('altea_schedule', { date: 'someday' }); if (!r.isError || !/ERROR\[BAD_INPUT\]/.test(r.text)) throw new Error(r.text.slice(0, 100)); return 'ok'; });
await evalCase('resource altea://schedule/tomorrow', async () => { const r = await call('resources/read', { uri: 'altea://schedule/tomorrow' }); if (!/events 20/.test(r.result?.contents?.[0]?.text || '')) throw new Error('empty'); return 'ok'; });

p.kill();
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`\n${pad('case', 46)} ${pad('result', 6)} ${pad('ms', 6)} note`);
for (const r of rows) console.log(`${pad(r.name, 46)} ${pad(r.ok ? 'PASS' : 'FAIL', 6)} ${pad(r.ms, 6)} ${r.note}`);
console.log(`\n${rows.length - failures}/${rows.length} passed`);
process.exit(failures ? 1 : 0);
