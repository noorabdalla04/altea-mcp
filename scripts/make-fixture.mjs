// Capture live payloads and scrub personal data → test/fixtures/*.txt (committed; used by the tests).
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HttpSession } from '../src/session.mjs';
import { parseRSC, eventsFromRows } from '../src/rsc.mjs';
import { resolveDate, toDDMMYYYY, DEFAULT_COMMUNITY_ID } from '../src/client.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
await mkdir(dir, { recursive: true });
const h = await HttpSession.load();

function replaceBalanced(text, keyPattern, replacement) {
  // keyPattern like '"paymentMethods":' followed by [ or {  → replace the balanced value
  let i = 0, out = '';
  for (;;) {
    const k = text.indexOf(keyPattern, i);
    if (k < 0) { out += text.slice(i); break; }
    let j = k + keyPattern.length; const open = text[j]; const close = open === '[' ? ']' : '}';
    if (open !== '[' && open !== '{') { out += text.slice(i, j); i = j; continue; }
    let depth = 0, inStr = false, esc = false;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === open) depth++; else if (ch === close) { depth--; if (depth === 0) { j++; break; } }
    }
    out += text.slice(i, k) + keyPattern + replacement; i = j;
  }
  return out;
}

function scrub(text) {
  const uid = (text.match(/"currentUser":\{[^}]*?"id":"([^"]+)"/) || text.match(/"uid":"([^"]+)"/) || [])[1];
  let t = text;
  if (uid) t = t.split(uid).join('usr_test');
  t = t.replace(/usrprk_[A-Za-z0-9]+/g, 'usrprk_test').replace(/bkg_[A-Za-z0-9]+/g, 'bkg_test').replace(/pm_[A-Za-z0-9]{8,}/g, 'pm_test');
  t = replaceBalanced(t, '"paymentMethods":', '[{"id":"pm_test","type":"user","label":"**** 0000","model":"visa","userId":"usr_test","default":1,"details":"01/30","gateway":"stripe","cardHolderName":"[redacted]","expired":false}]');
  t = replaceBalanced(t, '"linkedAccounts":', '[]');
  for (const key of ['displayName', 'photoURL', 'email', 'contactEmail', 'phoneNumber', 'friendlyName', 'birthday', 'gender', 'employer', 'addressFormatted', 'addressLine1', 'addressLine2', 'addressPostalcode', 'addressState', 'addressCity', 'addressLatitude', 'addressLongitude', 'addressPlaceid', 'addressCountryName', 'emergencyContactName', 'emergencyContactEmail', 'emergencyContactRelationship', 'emergencyPhoneNumber', 'cardHolderName', 'expiryDate']) {
    t = t.replace(new RegExp(`"${key}":"(?:[^"\\\\]|\\\\.)*"`, 'g'), `"${key}":"[redacted]"`);
  }
  return t;
}

const tomorrow = resolveDate('tomorrow');
const sched = await h.rsc(`/booking?date=${toDDMMYYYY(tomorrow)}&calendarGroup=Boutique%20Fitness&communityId=${DEFAULT_COMMUNITY_ID}`);
await writeFile(join(dir, 'schedule.txt'), scrub(sched));
const events = eventsFromRows(parseRSC(sched));
const target = events.find((e) => (e.spotsLeft ?? 0) > 0) || events[0];
if (target) { const ev = await h.rsc(`/booking/${target.id}`); await writeFile(join(dir, 'event.txt'), scrub(ev)); }
const bk = await h.rsc(`/?date=${resolveDate('today')}`);
await writeFile(join(dir, 'bookings.txt'), scrub(bk));
await h.persist();
console.log(`fixtures written to ${dir}: schedule (${sched.length}B, ${events.length} events), event (${target?.id}), bookings (${bk.length}B)`);
