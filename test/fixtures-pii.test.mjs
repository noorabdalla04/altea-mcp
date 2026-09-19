import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRows, serializeRows, scrubRSC } from '../scripts/scrub.mjs';
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('fixtures contain no embedded images, signatures, avatars, emails, phones or addresses', async () => {
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.txt'))) {
    const t = await readFile(join(dir, f), 'utf8');
    for (const re of [/data:image/, /;base64,/, /"signature":"[^\[]/, /greco-user-public/, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/, /\(\d{3}\) \d{3}-\d{4}/, /"addressLine1":"[^\[]/, /"phoneNumber":"[^\[]/, /"birthday":"[^\[]/]) assert.doesNotMatch(t, re, `${f} matches ${re}`);
  }
});

test('scrubRSC keeps text rows byte-valid and redacts data URIs', () => {
  const sig = 'data:image/png;base64,' + 'A'.repeat(300);
  const payload = `0:{"currentUser":{"id":"usr_real","email":"a@b.co","perks":[]}}\n1:T${Buffer.byteLength(sig).toString(16)},${sig}2:["after","usr_real"]\n`;
  const out = scrubRSC(payload);
  const rows = parseRows(out);
  assert.equal(rows[1].text, '[redacted]');
  assert.deepEqual(JSON.parse(rows[2].raw), ['after', 'usr_test']);
  assert.match(rows[0].raw, /"email":"\[redacted\]"/);
  assert.equal(serializeRows(parseRows(out)), out, 'round-trips');
});
