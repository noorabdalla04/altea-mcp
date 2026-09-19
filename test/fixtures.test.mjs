import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRSC, eventsFromRows, deepFindInRows } from '../src/rsc.mjs';
import { slimEvent } from '../src/client.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (f) => readFile(join(dir, f), 'utf8');

test('schedule fixture: events, event types, instructors, communities all parse', async () => {
  const rows = parseRSC(await load('schedule.txt'));
  const events = eventsFromRows(rows);
  assert.ok(events.length > 5, `expected events, got ${events.length}`);
  const s = slimEvent(events[0]);
  for (const k of ['id', 'title', 'date', 'time', 'end', 'studio', 'instructors', 'spotsLeft']) assert.ok(k in s, `missing ${k}`);
  assert.match(s.id, /^evt_/); assert.match(s.time, /^\d{2}:\d{2}$/);
  const types = deepFindInRows(rows, (j) => Array.isArray(j) && j[0]?.id?.startsWith?.('evttag_') && 'label' in j[0]);
  const instructors = deepFindInRows(rows, (j) => Array.isArray(j) && j[0]?.id?.startsWith?.('res_') && 'label' in j[0]);
  const communities = deepFindInRows(rows, (j) => Array.isArray(j) && typeof j[0]?.communityId === 'string' && Array.isArray(j[0].calendarGroups));
  assert.ok(types?.length >= 5); assert.ok(instructors?.length >= 5); assert.ok(communities?.length >= 3);
  assert.ok(communities.some((c) => c.communityName === 'Altea Ottawa' && c.calendarGroups.includes('Pickleball')));
});

test('event fixture: event object and booking context are found', async () => {
  const rows = parseRSC(await load('event.txt'));
  const ev = deepFindInRows(rows, (j) => j && typeof j === 'object' && !Array.isArray(j) && typeof j.id === 'string' && j.id.startsWith('evt_') && 'startDate' in j);
  const ctx = deepFindInRows(rows, (j) => j && typeof j === 'object' && !Array.isArray(j) && 'activeBookings' in j && 'context' in j);
  assert.ok(ev, 'event object'); assert.ok(ctx, 'booking context');
  assert.ok(Array.isArray(ctx.context.currentUser.perks) && ctx.context.currentUser.perks.length > 0, 'perks');
  const perk = ctx.context.currentUser.perks[0];
  assert.ok('perkId' in perk && 'userPerkId' in perk && 'cancellation' in perk);
  assert.equal(ctx.context.currentUser.paymentMethods[0].id, 'pm_test'); // scrubbed
});

test('bookings fixture: the dates-with-bookings row parses', async () => {
  const rows = parseRSC(await load('bookings.txt'));
  const counts = deepFindInRows(rows, (j) => Array.isArray(j) && Array.isArray(j[0]) && /^\d{4}-\d{2}-\d{2}$/.test(j[0][0]) && 'bookings' in (j[0][1] || {}));
  assert.ok(counts === undefined || Array.isArray(counts));
  assert.ok(!(await load('bookings.txt')).includes('addressLine1":"5'), 'address scrubbed');
});
