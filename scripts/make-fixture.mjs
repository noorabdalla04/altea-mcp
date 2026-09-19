// Capture live payloads and scrub personal data → test/fixtures/*.txt (committed; used by the tests).
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HttpSession } from '../src/session.mjs';
import { parseRSC, eventsFromRows } from '../src/rsc.mjs';
import { Altea, resolveDate, toDDMMYYYY } from '../src/client.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
await mkdir(dir, { recursive: true });
const h = await HttpSession.load();
const client = new Altea({ log: () => {} }); await client.init(); const COMMUNITY_ID = await client.defaultCommunityId(); await client.close();

import { scrubRSC as scrub } from './scrub.mjs';

const tomorrow = resolveDate('tomorrow');
const sched = await h.rsc(`/booking?date=${toDDMMYYYY(tomorrow)}&calendarGroup=Boutique%20Fitness&communityId=${COMMUNITY_ID}`);
await writeFile(join(dir, 'schedule.txt'), scrub(sched));
const events = eventsFromRows(parseRSC(sched));
const target = events.find((e) => (e.spotsLeft ?? 0) > 0) || events[0];
if (target) { const ev = await h.rsc(`/booking/${target.id}`); await writeFile(join(dir, 'event.txt'), scrub(ev)); }
// bookings page: prefer a saved raw capture taken while a booking existed (richer), else live
const rawArg = process.argv.find((a) => a.startsWith('--bookings-raw='));
const bk = rawArg ? await readFile(rawArg.slice('--bookings-raw='.length), 'utf8') : await h.rsc('/');
await writeFile(join(dir, 'bookings.txt'), scrub(bk));
await h.persist();
console.log(`fixtures written to ${dir}: schedule (${sched.length}B, ${events.length} events), event (${target?.id}), bookings (${bk.length}B)`);
