#!/usr/bin/env node
// altea — CLI for the Altea Active booking app (myaltea.app).
//   altea login                          sign in once (opens Chrome; cookies persist in ~/.altea)
//   altea status                         session + discovered actions
//   altea schedule [date] [--days N] [--group G] [--instructor X] [--type T] [--studio S]
//                  [--available] [--mine] [--query Q] [--after HH:MM] [--before HH:MM] [--json]
//   altea find <words…> [--days 7] [--group G] [--available] [--json]
//   altea event <evt_id> [--json]
//   altea bookings [--from D] [--days 30] [--json]
//   altea book <evt_id> [--force] [--perk prk_…] [--pm pm_…]
//   altea cancel <bkg_id|evt_id> [--force]
//   altea waitlist join|leave <evt_id>
//   altea meta [--refresh]              communities, calendar groups, event types, instructors
//   altea actions [--refresh]           discovered server-action ids for the current build
// date: YYYY-MM-DD | today | tomorrow | mon…sun | +N.  --community "Toronto" selects another club.
// book / waitlist-join open a real Chrome window for ~4 s (the backend rejects headless Chrome).
// Env: ALTEA_HEADLESS=1 to attempt headless anyway.  --verbose logs timings.

import { Altea, resolveDate, DEFAULT_GROUP, DEFAULT_COMMUNITY_ID } from '../src/client.mjs';
import { login, NotSignedIn } from '../src/session.mjs';

const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && !['json', 'available', 'mine', 'force', 'refresh', 'verbose', 'headed', 'desc'].includes(a.slice(2))) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  } else pos.push(a);
}
const [cmd, ...rest] = pos;
const out = (x) => process.stdout.write((typeof x === 'string' ? x : JSON.stringify(x, null, 2)) + '\n');
const log = flags.verbose ? (m) => process.stderr.write(`[altea] ${m}\n`) : () => {};
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);

function usage() {
  out(`altea <login|status|schedule|find|event|bookings|book|cancel|waitlist|meta|actions> …  (see header of altea.mjs)`);
}

async function resolveCommunity(client, input) {
  if (!input) return DEFAULT_COMMUNITY_ID;
  if (input.startsWith('com_')) return input;
  const m = await client.meta();
  const hit = m.communities.find((c) => c.name.toLowerCase().includes(input.toLowerCase()));
  if (!hit) throw new Error(`unknown community "${input}"; known: ${m.communities.map((c) => c.name).join(', ')}`);
  return hit.id;
}

async function resolveGroup(client, communityId, input) {
  if (!input) return DEFAULT_GROUP;
  const m = await client.meta();
  const c = m.communities.find((c) => c.id === communityId);
  const groups = c?.groups || [];
  const hit = groups.find((g) => g.toLowerCase() === input.toLowerCase()) || groups.find((g) => g.toLowerCase().includes(input.toLowerCase()));
  if (!hit) throw new Error(`unknown calendar group "${input}" for ${c?.name || communityId}; known: ${groups.join(', ')}`);
  return hit;
}

function printSchedule(res) {
  for (const d of res.days) {
    out(`\n${d.weekday} ${d.date} · ${d.group} · ${d.events.length} events`);
    for (const e of d.events) {
      const spots = e.myStatus ? `BOOKED(${e.myStatus})` : e.waitlisted ? 'WAITLISTED' : e.full ? 'FULL' : `${e.spotsLeft} left`;
      out(`  ${e.time}-${e.end}  ${pad(e.title, 34)} ${pad(e.studio, 22)} ${pad(e.instructors.join(', '), 18)} ${pad(spots, 14)} ${e.id}`);
    }
  }
  out(`\n${res.count} events ${res.from}..${res.to}`);
}

function printBookings(res) {
  if (!res.bookings.length) { out(`no bookings ${res.from}..${res.to}`); return; }
  for (const b of res.bookings) {
    const late = b.cancellation?.late ? ` LATE(fee ${b.cancellation.feeText})` : b.cancellation?.deadline ? ` free-cancel until ${b.cancellation.deadline.slice(0, 16)}` : '';
    out(`  ${b.date} ${b.time}  ${pad(b.title, 34)} ${pad(b.studio, 22)} ${pad(b.status, 10)} ${b.bookingId}  ${b.eventId}${late}`);
  }
}

async function main() {
  if (!cmd || flags.help) return usage();
  if (cmd === 'login') { await login({ log: (m) => process.stderr.write(m + '\n') }); return; }

  const client = new Altea({ log, headless: flags.headed ? false : undefined });
  await client.init();
  try {
    switch (cmd) {
      case 'status': return out(await client.status());
      case 'meta': return out(await client.meta({ refresh: !!flags.refresh }));
      case 'actions': return out(await client.ensureActions({ force: !!flags.refresh }));
      case 'schedule': {
        const communityId = await resolveCommunity(client, flags.community);
        const group = await resolveGroup(client, communityId, flags.group);
        const res = await client.schedule({ date: rest[0] || flags.date || 'today', days: Number(flags.days || 1), group, communityId, instructor: flags.instructor, type: flags.type, studio: flags.studio, query: flags.query, availableOnly: !!flags.available, mine: !!flags.mine, after: flags.after, before: flags.before, timeOfDay: flags.tod, withDescription: !!flags.desc });
        return flags.json ? out(res) : printSchedule(res);
      }
      case 'find': {
        const communityId = await resolveCommunity(client, flags.community);
        const group = await resolveGroup(client, communityId, flags.group);
        const res = await client.find({ query: rest.join(' ') || flags.query, from: flags.from || flags.date || 'today', days: Number(flags.days || 7), group, communityId, instructor: flags.instructor, type: flags.type, studio: flags.studio, availableOnly: !!flags.available, after: flags.after, before: flags.before });
        return flags.json ? out(res) : printSchedule(res);
      }
      case 'event': {
        const res = await client.event(rest[0]);
        if (flags.json) return out(res);
        const e = res.event;
        out(`${e.title}\n${e.weekday} ${e.date} ${e.time}-${e.end} (${e.duration} min) · ${e.studio} · ${e.community}\nInstructors: ${e.instructors.join(', ') || '-'} · Types: ${e.types.join(', ') || '-'} · Spots left: ${e.spotsLeft}${e.full ? ' (FULL)' : ''}\n${e.description ? e.description + '\n' : ''}`);
        out(res.myBooking ? `My booking: ${res.myBooking.bookingId} ${res.myBooking.status} · cancel policy: ${res.myBooking.cancellation?.text} · free-cancel deadline ${res.myBooking.cancellation?.deadline}${res.myBooking.cancellation?.late ? ' (LATE now)' : ''}` : 'Not booked.');
        for (const o of res.options) out(`Option: ${o.title} · ${o.unlimited ? 'unlimited' : `$${(o.price / 100).toFixed(2)}`} · booking opens ${o.bookableFrom ?? '?'} · cancel ${o.cancellation?.text ?? '?'}${o.disabled ? ' (disabled)' : ''}`);
        if (res.unsignedAgreements.length) out(`UNSIGNED agreements: ${res.unsignedAgreements.join(', ')}`);
        if (res.conflicts.length) out(`Conflicts: ${JSON.stringify(res.conflicts)}`);
        out(`Payment methods: ${res.paymentMethods.map((p) => `${p.label}${p.default ? ' (default)' : ''}${p.expired ? ' EXPIRED' : ''}`).join(', ') || 'none'} · waitlist: ${res.waitlistedUsers} people${res.waitlistPosition ? `, my position ${res.waitlistPosition}` : ''}`);
        return;
      }
      case 'bookings': {
        const res = await client.bookings({ from: flags.from || flags.date || 'today', to: flags.to, days: Number(flags.days || 30) });
        return flags.json ? out(res) : printBookings(res);
      }
      case 'book': {
        if (!rest[0]) throw new Error('book <evt_id>');
        return out(await client.book({ eventId: rest[0], force: !!flags.force, perkId: flags.perk, paymentMethodId: flags.pm }));
      }
      case 'cancel': {
        if (!rest[0]) throw new Error('cancel <bkg_id|evt_id>');
        const id = rest[0];
        return out(await client.cancel(id.startsWith('bkg_') ? { bookingId: id, eventId: flags.event, force: !!flags.force } : { eventId: id, force: !!flags.force }));
      }
      case 'waitlist': {
        const [action, eventId] = rest;
        return out(await client.waitlist({ eventId, action }));
      }
      default: return usage();
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  if (e instanceof NotSignedIn) { process.stderr.write(`not signed in: ${e.message}\n`); process.exit(2); }
  process.stderr.write(`error: ${e.stack || e.message}\n`);
  process.exit(1);
});
