import test from 'node:test';
import assert from 'node:assert/strict';
import { Altea } from '../src/client.mjs';

test('refusedAsBot recognises the backend bot verdict only', () => {
  assert.equal(Altea.refusedAsBot({ result: { data: { success: false, message: 'We are unable to process your booking at this time.' } } }), true);
  assert.equal(Altea.refusedAsBot({ result: { data: { success: true, message: 'Successfully joined waitlist' } } }), false);
  assert.equal(Altea.refusedAsBot({ result: { data: { success: false, message: 'Event is full' } } }), false);
  assert.equal(Altea.refusedAsBot({ result: null }), false);
});

test('window mode defaults: auto → hidden first; env and options override', () => {
  const a = new Altea(); assert.equal(a.windowMode, 'auto'); assert.equal(a.quietMode, 'hidden');
  const b = new Altea({ windowMode: 'visible' }); assert.equal(b.windowMode, 'visible');
  process.env.ALTEA_WINDOW = 'headless'; const c = new Altea(); assert.equal(c.windowMode, 'headless'); delete process.env.ALTEA_WINDOW;
});
