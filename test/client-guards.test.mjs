// Real-client tests with a fake HTTP layer (no network): guards for cancel/book, bookings parsing, dates, meta union.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Altea, resolveDate, resolveRange, parseTime, mergeMeta, shapePolicy } from '../src/client.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const policyIn = (hours) => ({ enabled: true, cancellationWindow: 480, cancellationPrice: 1000 });
const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();

function client({ rsc = async () => '', action = async () => ({ status: 200, text: '0:{"a":"$@1","f":"","q":"","i":false,"b":"b"}\n1:{"data":{"success":true}}\n', revalidated: true }) } = {}) {
  const c = new Altea({ log: () => {} });
  const calls = [];
  c.http = { rsc, html: async () => '', action: async (...a) => { calls.push(a); return action(...a); }, persist: async () => {}, cookies: [] };
  c.ensureActions = async () => ({ confirmBookingAction: 'cfm', cancelBookingAction: 'cxl', joinWaitlistAction: 'join', leaveWaitlistAction: 'leave' });
  c.meta = async () => ({ communities: [{ id: 'com_x', name: 'Altea Test', groups: ['Boutique Fitness', 'Pickleball'] }], types: [], instructors: [], defaultCommunityId: 'com_x', rules: {} });
  return { c, calls };
}
/** Minimal event-page payload: an event object row + a booking-context row. */
function eventPayload({ id = 'evt_t_1', start = inHours(30), activeBookings = [], perks, paymentMethods = [{ id: 'pm_1', default: 1, expired: false, label: '**** 0000' }], unsignedAgreements = [], eventConflicts = [], spotsLeft = 5 }) {
  const me = { id: 'usr_me', perks: perks ?? [{ perkId: 'prk_u', userPerkId: 'usrprk_u', title: 'Gold', price: 0, unlimited: true, bookingWindow: 2880, cancellation: policyIn() }], paymentMethods, unsignedAgreements, eventConflicts, alerts: [], waitlist: 0 };
  const ev = { id, startDate: start, title: 'Test Class', duration: 50, calendar: 'Studio', resources: {}, spotsLeft };
  const ctx = { activeBookings, context: { currentUser: me, eventAgreements: [], bookingOptionAgreements: [] }, possibleBookings: [{ id: 'usr_me', defaultSelectedPerk: 'usr_me__own__prk_u|usrprk_u|0|true' }], waitlistedUsers: [] };
  return `1:${JSON.stringify(ev)}\n2:${JSON.stringify(ctx)}\n`;
}

test('cancel by bookingId looks the booking up and refuses a late cancellation', async () => {
  const { c, calls } = client();
  c.bookings = async () => ({ bookings: [{ bookingId: 'bkg_late', eventId: 'evt_l', title: 'Hot Yin', canCancel: true, cancellation: { enabled: true, late: true, windowHours: 8, feeText: '$10.00 + tax', deadline: 'x' } }] });
  await assert.rejects(c.cancel({ bookingId: 'bkg_late' }), (e) => e.code === 'LATE_CANCEL');
  assert.equal(calls.length, 0, 'nothing posted');
  await assert.rejects(c.cancel({ bookingId: 'bkg_unknown' }), (e) => e.code === 'NOT_FOUND');
  c.event = async () => ({ event: { id: 'evt_l' }, myBooking: null });
  const forced = await c.cancel({ bookingId: 'bkg_late', force: true });
  assert.equal(forced.ok, true); assert.equal(calls.length, 1); assert.equal(calls[0][0], '/');
});

test('book: paid options are never chosen implicitly, force never bypasses waivers, window guard', async () => {
  const paid = [{ perkId: 'prk_d', userPerkId: 'usrprk_d', title: 'Drop-in', price: 2500, unlimited: false, bookingWindow: 2880, cancellation: policyIn() }];
  let payload = eventPayload({ perks: paid });
  const { c, calls } = client({ rsc: async () => payload });
  await assert.rejects(c.book({ eventId: 'evt_t_1' }), (e) => e.code === 'PAID_OPTION');
  payload = eventPayload({ unsignedAgreements: [{ id: 'agr_1', title: 'Waiver' }] });
  await assert.rejects(c.book({ eventId: 'evt_t_1', force: true }), (e) => e.code === 'UNSIGNED_AGREEMENT');
  payload = eventPayload({ start: inHours(72) });
  await assert.rejects(c.book({ eventId: 'evt_t_1' }), (e) => e.code === 'WINDOW_NOT_OPEN' && /opens/.test(e.message));
  payload = eventPayload({ spotsLeft: 0 });
  await assert.rejects(c.book({ eventId: 'evt_t_1' }), (e) => e.code === 'EVENT_FULL');
  assert.equal(calls.length, 0, 'no action posted by refused bookings');
});

test('event(): a linked account\'s booking is not reported as mine', async () => {
  const child = [{ id: 'usr_child' }, { id: 'bkg_child', status: 'CONFIRMED', perk: { cancellation: policyIn() } }];
  const mine = [{ id: 'usr_me' }, { id: 'bkg_mine', status: 'CONFIRMED', perk: { cancellation: policyIn() } }];
  const { c } = client({ rsc: async () => eventPayload({ activeBookings: [child] }) });
  const r = await c.event('evt_t_1');
  assert.equal(r.myBooking, null); assert.equal(r.othersBooked, 1);
  const { c: c2 } = client({ rsc: async () => eventPayload({ activeBookings: [child, mine] }) });
  assert.equal((await c2.event('evt_t_1')).myBooking.bookingId, 'bkg_mine');
});

test('bookings(): one upcoming-window fetch, DD-MM-YYYY date, fixture item parses with deadline', async () => {
  const text = await readFile(join(fixtures, 'bookings.txt'), 'utf8');
  const paths = [];
  const { c } = client({ rsc: async (p) => { paths.push(p); return text; } });
  const r = await c.bookings({ from: '2026-09-19', to: '2026-09-30' });
  assert.equal(paths[0], '/?date=19-09-2026');
  assert.equal(paths.length, 1, 'single fetch within one month');
  assert.equal(r.count, 1); const b = r.bookings[0];
  assert.equal(b.bookingId, 'bkg_test'); assert.match(b.eventId, /^evt_/); assert.equal(b.date, '2026-09-20'); assert.equal(b.time, '09:00');
  assert.equal(b.cancellation.windowHours, 8); assert.equal(b.cancellation.deadline, '2026-09-20T01:00-04:00'); assert.equal(b.cancellation.feeText, '$10.00 + tax');
  assert.ok(r.datesWithBookings.includes('2026-09-20'));
});

test('dates: yearless and impossible inputs are rejected, ranges resolve, weekday words work', () => {
  const today = '2026-09-19'; // Saturday
  assert.throws(() => resolveDate('sept 21', today), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => resolveDate('2026-09-31', today), (e) => e.code === 'BAD_INPUT');
  assert.equal(resolveDate('-7', today), '2026-09-12');
  assert.equal(resolveDate('Oct 5 2026', today), '2026-10-05');
  assert.equal(resolveDate('next sat', today), '2026-09-26');
  assert.deepEqual(resolveRange('this week', today), { date: today, days: 2 });
  assert.deepEqual(resolveRange('next week', today), { date: '2026-09-21', days: 7 });
  assert.deepEqual(resolveRange('weekend', today), { date: today, days: 2 });
  assert.equal(resolveRange('2026-10-01', today), null);
});

test('times: bare 1..11 is ambiguous, 24 h and am/pm forms parse', () => {
  assert.throws(() => parseTime('3'), (e) => e.code === 'BAD_INPUT');
  assert.equal(parseTime('15'), '15:00'); assert.equal(parseTime('3pm'), '15:00'); assert.equal(parseTime('12'), '12:00'); assert.equal(parseTime('9:30 am'), '09:30');
});

test('mergeMeta unions by id; shapePolicy respects enabled:false', () => {
  const m = mergeMeta({ types: [{ id: 't1', label: 'Yoga' }], instructors: [{ id: 'r1', name: 'A' }] }, { types: [{ id: 't2', label: 'Cycle' }], instructors: [{ id: 'r1', name: 'A' }, { id: 'r2', name: 'B' }], communities: [] });
  assert.equal(m.types.length, 2); assert.equal(m.instructors.length, 2);
  const p = shapePolicy({ enabled: false, cancellationWindow: 480, cancellationPrice: 1000 }, Date.now() + 36e5);
  assert.equal(p.enabled, false); assert.equal(p.deadline, null); assert.equal(p.text, 'not cancellable');
});

test('group aliases resolve to calendar groups', async () => {
  const { c } = client();
  assert.equal(await c.resolveGroup('com_x', 'courts'), 'Pickleball');
  assert.equal(await c.resolveGroup('com_x', 'pickle'), 'Pickleball');
  assert.equal(await c.resolveGroup('com_x', undefined), 'Boutique Fitness');
  await assert.rejects(c.resolveGroup('com_x', 'skating'), (e) => e.code === 'BAD_INPUT');
});

test('status: the session expiry follows the sign-in cookie, not short-lived helper cookies', async () => {
  const { c } = client({ rsc: async () => '"currentUser":{"id":"usr_me","name":"x"}' });
  const now = Date.now() / 1000, day = 86400;
  c.http.cookies = [
    { name: '__stripe_sid', domain: '.myaltea.app', expires: now + 1800 },
    { name: '__Secure-firebase.auth.v2', domain: '.myaltea.app', expires: now + 12 * day, httpOnly: true },
    { name: 'tz', domain: 'myaltea.app', expires: now + 365 * day },
  ];
  const s = await c.status();
  assert.equal(s.signedIn, true); assert.equal(s.userId, 'usr_me');
  assert.ok(Math.abs(Date.parse(s.sessionExpiresAt) - (now + 12 * day) * 1000) < 120_000, `expiry follows the auth cookie: ${s.sessionExpiresAt}`);
  c.http.cookies = [{ name: 'other', domain: '.myaltea.app', expires: now + 2 * day }];
  const f = await c.status();
  assert.ok(Math.abs(Date.parse(f.sessionExpiresAt) - (now + 2 * day) * 1000) < 120_000, 'falls back to the earliest cookie when no auth cookie is present');
});
