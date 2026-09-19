import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRSC, deepFind, parseActionResponse, eventsFromRows } from '../src/rsc.mjs';

test('parseRSC handles text rows by byte length (multi-byte chars) and continues parsing', () => {
  const txt = 'héllo “quoted”'; const len = Buffer.byteLength(txt).toString(16);
  const payload = `0:{"a":"$@1"}\n1:T${len},${txt}2:["after",1]\n3:I[1,["x"],"y"]\n`;
  const rows = parseRSC(payload);
  assert.equal(rows['1'].type, 'T');
  assert.equal(rows['1'].text, txt);
  assert.deepEqual(rows['2'].json, ['after', 1]);
  assert.equal(rows['3'].json, undefined); // import rows are not JSON
  assert.deepEqual(rows['0'].json, { a: '$@1' });
});

test('deepFind finds nested arrays/objects', () => {
  const j = { x: [{ y: { list: [{ id: 'evt_1', startDate: '2026-01-01T00:00:00Z' }] } }] };
  const hit = deepFind(j, (v) => Array.isArray(v) && v[0]?.id?.startsWith('evt_'));
  assert.equal(hit[0].id, 'evt_1');
  assert.equal(eventsFromRows({ r: { type: 'J', raw: '', json: j } })[0].id, 'evt_1');
});

test('parseActionResponse resolves the return value and server errors', () => {
  const ok = parseActionResponse('0:{"a":"$@1","f":"","q":"","i":false,"b":"build1"}\n1:{"data":{"success":true}}\n');
  assert.equal(ok.buildId, 'build1'); assert.equal(ok.result.data.success, true); assert.equal(ok.serverError, null);
  const bad = parseActionResponse('0:{"a":"$@1","f":"","q":"","i":false,"b":"b"}\n1:{"serverError":"nope"}\n');
  assert.equal(bad.serverError, 'nope');
});
