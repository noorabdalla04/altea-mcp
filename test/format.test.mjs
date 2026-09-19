import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseSeries, renderSchedule, compactEvent } from '../src/format.mjs';

const slot = (i, o = {}) => ({ id: `evt_s_${i}`, title: 'Recovery Pod', studio: 'Recovery Lounge', time: `${String(8 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`, end: '..', instructors: [], spotsLeft: i % 3 === 0 ? 0 : 1, full: i % 3 === 0, myStatus: null, waitlisted: false, group: 'Recovery & Wellness', date: '2026-09-20', weekday: 'Sun', start: '2026-09-20T08:00-04:00', ...o });

test('collapseSeries folds long identical runs and keeps singles', () => {
  const events = [...Array.from({ length: 20 }, (_, i) => slot(i)), slot(99, { id: 'evt_x', title: 'Hot Yin', studio: 'Hot Yoga Studio', time: '14:00' })];
  const { singles, series } = collapseSeries(events);
  assert.equal(singles.length, 1); assert.equal(series.length, 1);
  assert.equal(series[0].count, 20); assert.ok(series[0].withSpots > 0); assert.ok(series[0].nextOpen);
});

test('renderSchedule concise is much smaller than detailed and mentions the series', () => {
  const events = Array.from({ length: 40 }, (_, i) => slot(i));
  const res = { from: '2026-09-20', to: '2026-09-20', groups: ['Recovery & Wellness'], count: 40, days: [{ date: '2026-09-20', weekday: 'Sun', events }] };
  const c = renderSchedule(res, { format: 'concise' }); const d = renderSchedule(res, { format: 'detailed' });
  assert.match(c.text, /40 slots/); assert.ok(c.text.split('\n').length < 6, 'one line per series');
  assert.ok(JSON.stringify(c.structured).length < JSON.stringify(d.structured).length / 3, 'concise structured is at least 3× smaller');
  assert.deepEqual(Object.keys(compactEvent(slot(1))), ['id', 'date', 'time', 'title', 'studio', 'spots', 'group']);
});
