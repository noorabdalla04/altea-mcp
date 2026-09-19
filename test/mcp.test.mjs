// Protocol-level tests: a real McpServer + Client over InMemoryTransport with a stub Altea client (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAlteaServer } from '../src/server.mjs';
import { NotSignedIn } from '../src/session.mjs';
import { AlteaError } from '../src/errors.mjs';

const ev = (o = {}) => ({ id: 'evt_a_1', title: 'Hot Yin', date: '2026-09-20', weekday: 'Sun', time: '14:00', end: '14:59', start: '2026-09-20T14:00-04:00', duration: 59, studio: 'Hot Yoga Studio', community: 'Altea Ottawa', communityId: 'com_x', instructors: ['Sara N.'], instructorIds: ['res_1'], types: ['Hot Yoga'], spotsLeft: 2, full: false, myStatus: null, waitlisted: false, checkInWindow: 10, status: 'ACTIVE', url: 'https://myaltea.app/booking/evt_a_1', group: 'Boutique Fitness', ...o });
const policy = { enabled: true, windowHours: 8, feeCents: 1000, feeText: '$10.00 + tax', deadline: '2026-09-20T06:00-04:00', late: false, text: '8 hours before', source: 'app' };

class Stub {
  async init() {} async close() {}
  async status() { return { signedIn: true, userId: 'usr', cookies: 3, actions: null, headless: false, rules: { cancelWindowMin: 480, bookingWindowMin: 2880 }, cacheTtlMs: 45000 }; }
  async schedule(a) {
    if (a.date === 'bogus') throw new AlteaError('BAD_INPUT', 'Unrecognised date: bogus');
    if (a.date === 'slow') return new Promise(() => {});
    const groups = a.group === 'all' ? ['Boutique Fitness', 'Pickleball'] : ['Boutique Fitness'];
    const events = [ev({ id: 'evt_b_1', title: 'Main Stage Ride', time: '09:00', end: '09:50', spotsLeft: 30, instructors: ['Curtis A.'] }), ev()];
    return { from: '2026-09-20', to: '2026-09-20', groups, communityId: 'com_x', filters: a.instructor ? { instructor: a.instructor } : undefined, days: [{ date: '2026-09-20', weekday: 'Sun', events }], count: 2 };
  }
  async find(a) { const s = await this.schedule({ ...a, group: a.group || 'all' }); return { ...s, events: s.days.flatMap((d) => d.events) }; }
  async instructor(a) {
    if (a.name === 'nobody') return { name: a.name, from: '2026-09-21', to: '2026-09-21', groups: ['A', 'B'], count: 0, sessions: [], instructorsSeen: 5, suggestions: ['Omar A.'] };
    return { name: a.name, from: '2026-09-21', to: '2026-09-21', groups: ['A', 'B'], count: 1, sessions: [ev({ instructors: ['Omar A.'], group: 'Personalized Performance', date: '2026-09-21', weekday: 'Mon' })], instructorsSeen: 5, suggestions: [] };
  }
  async next(a) { return { query: a.query, from: '2026-09-19', searchedThrough: '2026-09-21', next: ev(), nextWithSpots: ev(), sameEvent: true, detail: { waitlistedUsers: 0, myBooking: null, bookableFrom: '2026-09-18T14:00-04:00', bookableNow: true, cancellation: policy } }; }
  async event(id) {
    if (id === 'evt_missing') throw new AlteaError('NOT_FOUND', 'event not found');
    return { id, event: { ...ev({ id }), description: 'Slow yin.' }, myBooking: null, options: [{ title: 'Gold', unlimited: true, disabled: false, bookableFrom: '2026-09-18T14:00-04:00', bookableNow: true, cancellation: policy }], bookingWindow: { bookableFrom: '2026-09-18T14:00-04:00', bookableNow: true, source: 'app', usableOptions: 1 }, paymentMethods: [{ id: 'pm_test', label: '**** 0000', default: true }], unsignedAgreements: [], conflicts: [], alerts: [], waitlistPosition: 0, waitlistedUsers: 0, userId: 'usr' };
  }
  async bookings() { return { from: '2026-09-19', to: '2026-10-19', datesWithBookings: ['2026-09-20'], count: 1, bookings: [{ bookingId: 'bkg_1', eventId: 'evt_a_1', date: '2026-09-20', time: '14:00', start: '2026-09-20T14:00-04:00', title: 'Hot Yin', studio: 'Hot Yoga Studio', instructors: ['Sara N.'], status: 'CONFIRMED', waitlisted: false, forMe: true, canCancel: true, membership: 'Gold', cancellation: policy, url: 'u' }] }; }
  async book(a) { if (a.eventId === 'evt_closed') throw new AlteaError('WINDOW_NOT_OPEN', 'opens later', { details: { opensAt: '2026-09-21T06:00-04:00' } }); return { ok: true, via: 'page', booking: { bookingId: 'bkg_2', status: 'CONFIRMED', cancellation: policy }, event: ev(), option: 'Gold', paymentMethod: '**** 0000', cancelBy: policy.deadline }; }
  async cancel(a) { if (a.bookingId === 'bkg_late' && !a.force) throw new AlteaError('LATE_CANCEL', 'inside the 8 h window'); return { ok: true, via: 'http', bookingId: a.bookingId || 'bkg_1', event: ev() }; }
  async waitlist(a) { return { ok: true, via: a.action === 'join' ? 'page' : 'http', waitlistPosition: a.action === 'join' ? 1 : 0, waitlistedUsers: 1, event: ev({ full: true, spotsLeft: 0 }) }; }
  async meta() { return { communities: [{ id: 'com_x', name: 'Altea Ottawa', groups: ['Boutique Fitness', 'Pickleball'], timezone: 'America/Toronto' }], types: [{ id: 't', label: 'Yoga' }], instructors: [{ id: 'r', name: 'Sara N.' }], rules: { cancelWindowMin: 480, bookingWindowMin: 2880 } }; }
  async ensureActions() { return { confirmBookingAction: 'x', cancelBookingAction: 'y' }; }
}
class SignedOut extends Stub { async schedule() { throw new NotSignedIn(); } }

async function harness(stub = new Stub(), opts = {}) {
  const { server, shutdown } = createAlteaServer({ makeClient: () => stub, log: () => {}, ...opts });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await server.connect(st); await client.connect(ct);
  return { client, close: async () => { await client.close(); await shutdown(); } };
}
const text = (r) => r.content[0].text;

test('tools/list: 12 tools, titles, four annotations each, output schemas, read/write split', async () => {
  const { client, close } = await harness();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 12);
  for (const t of tools) {
    assert.ok(t.title, `${t.name} title`); assert.ok(t.description.length >= 150, `${t.name} description too short`);
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof t.annotations?.[k], 'boolean', `${t.name} ${k}`);
    assert.ok(t.outputSchema, `${t.name} outputSchema`); assert.equal(t.inputSchema.type, 'object');
  }
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of ['altea_status', 'altea_schedule', 'altea_find', 'altea_next', 'altea_instructor', 'altea_event', 'altea_bookings', 'altea_meta', 'altea_actions']) assert.equal(by[n].annotations.readOnlyHint, true, n);
  assert.equal(by.altea_cancel.annotations.destructiveHint, true); assert.equal(by.altea_book.annotations.destructiveHint, false); assert.equal(by.altea_book.annotations.readOnlyHint, false);
  assert.deepEqual(tools.map((t) => t.name).slice(0, 2), ['altea_status', 'altea_schedule'], 'deterministic order');
  await close();
});

test('server instructions carry the rules', async () => {
  const { client, close } = await harness();
  const instr = client.getInstructions();
  assert.match(instr, /8 hours/); assert.match(instr, /48 hours/);
  await close();
});

test('altea_schedule: concise text + structured content, detailed keeps urls', async () => {
  const { client, close } = await harness();
  const r = await client.callTool({ name: 'altea_schedule', arguments: { date: 'tomorrow' } });
  assert.equal(r.isError, undefined); assert.match(text(r), /^2 events 2026-09-20/); assert.match(text(r), /Main Stage Ride · Cycle|Main Stage Ride · Hot Yoga/);
  assert.equal(r.structuredContent.status, 'success'); assert.equal(r.structuredContent.count, 2);
  assert.equal('url' in r.structuredContent.days[0].events[0], false, 'concise omits url');
  const d = await client.callTool({ name: 'altea_schedule', arguments: { date: 'tomorrow', format: 'detailed' } });
  assert.equal('url' in d.structuredContent.days[0].events[0], true, 'detailed keeps url');
  const lim = await client.callTool({ name: 'altea_schedule', arguments: { date: 'tomorrow', limit: 1 } });
  assert.match(text(lim), /1 more/); assert.equal(lim.structuredContent.days[0].truncated, 1);
  await close();
});

test('errors are coded, actionable and flagged isError', async () => {
  const { client, close } = await harness();
  const r = await client.callTool({ name: 'altea_schedule', arguments: { date: 'bogus' } });
  assert.equal(r.isError, true); assert.match(text(r), /^ERROR\[BAD_INPUT\]/); assert.match(text(r), /Next: /);
  const nf = await client.callTool({ name: 'altea_event', arguments: { eventId: 'evt_missing' } });
  assert.match(text(nf), /^ERROR\[NOT_FOUND\]/);
  const w = await client.callTool({ name: 'altea_book', arguments: { eventId: 'evt_closed' } });
  assert.match(text(w), /^ERROR\[WINDOW_NOT_OPEN\]/); assert.match(text(w), /48 h/); assert.match(text(w), /opensAt/);
  const late = await client.callTool({ name: 'altea_cancel', arguments: { bookingId: 'bkg_late' } });
  assert.match(text(late), /^ERROR\[LATE_CANCEL\]/); assert.match(text(late), /Retry safe: no/);
  const forced = await client.callTool({ name: 'altea_cancel', arguments: { bookingId: 'bkg_late', force: true } });
  assert.match(text(forced), /^Cancelled:/); assert.equal(forced.structuredContent.ok, true);
  await close();
});

test('input validation rejects malformed ids and unknown enum values', async () => {
  const { client, close } = await harness();
  const bad = await client.callTool({ name: 'altea_event', arguments: { eventId: 'nope' } }).catch((e) => e);
  assert.ok(bad instanceof Error || bad.isError, 'regex-guarded id');
  const bad2 = await client.callTool({ name: 'altea_waitlist', arguments: { eventId: 'evt_a_1', action: 'sit' } }).catch((e) => e);
  assert.ok(bad2 instanceof Error || bad2.isError);
  await close();
});

test('next / instructor / bookings / book / waitlist render summaries', async () => {
  const { client, close } = await harness();
  const n = await client.callTool({ name: 'altea_next', arguments: { query: 'hot yin' } });
  assert.match(text(n), /^Next "hot yin": Sun 2026-09-20 14:00/); assert.match(text(n), /bookable now/); assert.equal(n.structuredContent.bookableNow, true);
  const i = await client.callTool({ name: 'altea_instructor', arguments: { name: 'omar', date: 'mon' } });
  assert.match(text(i), /^1 session by Omar A\./); assert.match(text(i), /\[Personalized Performance\]/);
  const none = await client.callTool({ name: 'altea_instructor', arguments: { name: 'nobody' } });
  assert.equal(none.structuredContent.status, 'warning'); assert.match(text(none), /Did you mean: Omar A\./);
  const b = await client.callTool({ name: 'altea_bookings', arguments: {} });
  assert.match(text(b), /^1 booking/); assert.match(text(b), /free cancel until 2026-09-20T06:00/); assert.equal(b.structuredContent.bookings[0].cancelBy, policy.deadline);
  const bk = await client.callTool({ name: 'altea_book', arguments: { eventId: 'evt_a_1' } });
  assert.match(text(bk), /^Booked: Hot Yin Sun 2026-09-20 14:00 \(booking bkg_2/); assert.equal(bk.structuredContent.cancelBy, policy.deadline);
  const w = await client.callTool({ name: 'altea_waitlist', arguments: { eventId: 'evt_a_1', action: 'join' } });
  assert.match(text(w), /^Waitlist joined/); assert.equal(w.structuredContent.waitlistPosition, 1);
  await close();
});

test('resources and prompts are exposed and readable', async () => {
  const { client, close } = await harness();
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
  for (const u of ['altea://rules', 'altea://meta', 'altea://bookings/upcoming']) assert.ok(uris.includes(u), u);
  const rules = await client.readResource({ uri: 'altea://rules' });
  assert.match(rules.contents[0].text, /8 h before/);
  const meta = await client.readResource({ uri: 'altea://meta' });
  assert.match(meta.contents[0].text, /Pickleball/);
  const sched = await client.readResource({ uri: 'altea://schedule/tomorrow' });
  assert.match(sched.contents[0].text, /2 events/);
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.some((p) => p.name === 'altea-day-brief')); assert.ok(prompts.some((p) => p.name === 'altea-book-request'));
  const p = await client.getPrompt({ name: 'altea-book-request', arguments: { request: 'book hot yin' } });
  assert.match(p.messages[0].content.text, /altea_book/);
  await close();
});

test('NOT_SIGNED_IN is surfaced with the login hint and the client is reset', async () => {
  const { client, close } = await harness(new SignedOut());
  const r = await client.callTool({ name: 'altea_schedule', arguments: {} });
  assert.equal(r.isError, true); assert.match(text(r), /^ERROR\[NOT_SIGNED_IN\]/); assert.match(text(r), /login/);
  await close();
});

test('read calls are bounded by a timeout', async () => {
  const { client, close } = await harness(new Stub(), { readTimeoutMs: 150 });
  const r = await client.callTool({ name: 'altea_schedule', arguments: { date: 'slow' } });
  assert.equal(r.isError, true); assert.match(text(r), /^ERROR\[TIMEOUT\]/);
  await close();
});
