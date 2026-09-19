import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, resolveDate, addDays, weekdayOf, matchesFilters, normaliseFilters, shapePolicy, rankNames, RULES } from '../src/client.mjs';

test('parseTime accepts 24h, am/pm and compact forms', () => {
  assert.equal(parseTime('15:00'), '15:00');
  assert.equal(parseTime('3pm'), '15:00');
  assert.equal(parseTime('3:30 pm'), '15:30');
  assert.equal(parseTime('12am'), '00:00');
  assert.equal(parseTime('12pm'), '12:00');
  assert.equal(parseTime('7h'), '07:00');
  assert.equal(parseTime('0730'), '07:30');
  assert.throws(() => parseTime('25:00'));
});

test('resolveDate handles relative words with an injected today', () => {
  const today = '2026-09-19'; // Saturday
  assert.equal(resolveDate('today', today), today);
  assert.equal(resolveDate('tomorrow', today), '2026-09-20');
  assert.equal(resolveDate('+3', today), '2026-09-22');
  assert.equal(resolveDate('mon', today), '2026-09-21');
  assert.equal(resolveDate('sat', today), today);          // today counts
  assert.equal(resolveDate('next sat', today), '2026-09-26'); // "next" skips today
  assert.equal(resolveDate('20-09-2026', today), '2026-09-20');
  assert.equal(weekdayOf('2026-09-21'), 'Mon');
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
});

const ev = { title: 'Advanced Court 1 | Pickleball', studio: 'Pickleball Courts', instructors: [], types: [], time: '15:00', end: '15:59', spotsLeft: 4, full: false, myStatus: null, waitlisted: false };
const yin = { title: 'Hot Yin', studio: 'Hot Yoga Studio', instructors: ['Sara N.'], types: ['Yoga', 'Hot Yoga'], time: '14:00', end: '14:59', spotsLeft: 0, full: true, myStatus: null, waitlisted: false };

test('at/near/timeOfDay/query/instructor filters', () => {
  assert.equal(matchesFilters(ev, normaliseFilters({ at: '3pm' })), true);
  assert.equal(matchesFilters(ev, normaliseFilters({ at: '3:30pm' })), true);   // in progress
  assert.equal(matchesFilters(ev, normaliseFilters({ at: '4pm' })), false);
  assert.equal(matchesFilters(ev, normaliseFilters({ at: '14:45', near: 30 })), true);
  assert.equal(matchesFilters(ev, normaliseFilters({ at: '14:00', near: 30 })), false);
  assert.equal(matchesFilters(ev, { timeOfDay: 'lateAfternoon' }), true);
  assert.equal(matchesFilters(ev, { availableOnly: true }), true);
  assert.equal(matchesFilters(yin, { availableOnly: true }), false);
  assert.equal(matchesFilters(yin, { query: 'hot yin' }), true);
  assert.equal(matchesFilters(yin, { query: 'yin sara' }), true);
  assert.equal(matchesFilters(yin, { instructor: 'sara' }), true);
  assert.equal(matchesFilters(yin, { instructor: 'omar' }), false);
  assert.equal(matchesFilters(yin, { type: 'hot yoga' }), true);
  assert.equal(matchesFilters(ev, { after: '15:00', before: '16:00' }), true);
});

test('shapePolicy applies the 8 h rule and detects late cancellation', () => {
  const in2h = Date.now() + 2 * 3600_000, in10h = Date.now() + 10 * 3600_000;
  const late = shapePolicy({ enabled: 1, cancellationWindow: 480, cancellationPrice: 1000 }, in2h);
  assert.equal(late.late, true); assert.equal(late.windowHours, 8); assert.equal(late.feeText, '$10.00 + tax');
  const fine = shapePolicy({ enabled: 1, cancellationWindow: 480, cancellationPrice: 1000 }, in10h);
  assert.equal(fine.late, false);
  const fallback = shapePolicy(null, in2h);
  assert.equal(fallback.windowHours, RULES.cancelWindowMin / 60); assert.equal(fallback.source, 'rules'); assert.equal(fallback.late, true);
});

test('rankNames suggests close instructor names', () => {
  const s = rankNames('omar', ['Amy M.', 'Omar A.', 'Sara N.', 'Timo C.']);
  assert.equal(s[0], 'Omar A.');
  const fuzzy = rankNames('omer', ['Amy M.', 'Omar A.', 'Sara N.']);
  assert.equal(fuzzy[0], 'Omar A.');
});
