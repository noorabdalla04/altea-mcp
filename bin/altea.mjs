#!/usr/bin/env node
// altea — CLI for the Altea Active booking app (myaltea.app).
//
//   altea login                              sign in once (opens Chrome; cookies persist in ~/.altea)
//   altea status | rules | meta [--refresh] | actions [--refresh]
//   altea schedule [date] [--days N] [--group G|all] [--instructor X] [--type T] [--studio S] [--query Q]
//                  [--available] [--mine] [--after T] [--before T] [--at T] [--near MIN] [--tod BAND] [--json]
//   altea find <words…> [--days 7] [--group G]           search every calendar group (default) for N days
//   altea next <words…> [--days 14] [--instructor X]     next future occurrence + next one with spots
//   altea who <name> [date] [--days N]                   everything an instructor teaches (all groups)
//   altea event <evt_id> [--json]
//   altea bookings [--from D] [--days 30] [--json]
//   altea book <evt_id> [--force] [--window MODE]        bot-guarded route: hidden Chrome by default
//   altea cancel <bkg_id|evt_id> [--force]               refuses late cancels (8 h rule) unless --force
//   altea waitlist join|leave <evt_id>
//
// date: YYYY-MM-DD | today | tomorrow | mon…sun | next mon | +N.   time: 15:00 | 3pm | 3:30pm
// --group all searches every group of the club (Boutique Fitness, Pickleball, Aquatics, …).
// --community toronto selects another club.  --verbose logs timings.  ALTEA_HEADLESS=1 forces headless.

import { Altea, RULES, ALL_GROUPS } from '../src/client.mjs';
import { login, NotSignedIn } from '../src/session.mjs';

const BOOL = new Set(['json', 'available', 'mine', 'force', 'refresh', 'verbose', 'headed', 'desc', 'all', 'include-full', 'help', 'nocache']);
const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (eq > 0) flags[key] = a.slice(eq + 1);
    else if (BOOL.has(key) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) flags[key] = true;
    else flags[key] = argv[++i];
  } else pos.push(a);
}
const [cmd, ...rest] = pos;
const out = (x) => process.stdout.write((typeof x === 'string' ? x : JSON.stringify(x, null, 2)) + '\n');
const log = flags.verbose ? (m) => process.stderr.write(`[altea] ${m}\n`) : () => {};
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const groupArg = flags.all ? ALL_GROUPS : flags.group;

const spotsText = (e) => (e.myStatus ? `BOOKED(${e.myStatus})` : e.waitlisted ? 'WAITLISTED' : e.full ? 'FULL' : `${e.spotsLeft} left`);
const line = (e, showGroup) => `  ${e.time}-${e.end}  ${pad(e.title, 34)} ${pad(e.studio, 22)} ${pad(e.instructors.join(', '), 18)} ${pad(spotsText(e), 14)} ${showGroup ? pad(e.group, 16) + ' ' : ''}${e.id}`;

function printSchedule(res) {
  const showGroup = res.groups.length > 1;
  for (const d of res.days) {
    out(`\n${d.weekday} ${d.date} · ${res.groups.length > 1 ? 'all groups' : res.groups[0]} · ${d.events.length} events${d.errors ? ' · errors: ' + d.errors.join('; ') : ''}`);
    for (const e of d.events) out(line(e, showGroup));
  }
  out(`\n${res.count} events ${res.from}..${res.to}`);
}

function printBookings(res) {
  if (!res.bookings.length) { out(`no bookings ${res.from}..${res.to}`); return; }
  for (const b of res.bookings) {
    const c = b.cancellation;
    const tail = c?.late ? `LATE (fee ${c.feeText ?? 'applies'})` : c?.deadline ? `free-cancel until ${c.deadline.slice(0, 16)}` : '';
    out(`  ${b.date} ${b.time}  ${pad(b.title, 34)} ${pad(b.studio, 22)} ${pad(b.status, 10)} ${b.bookingId}  ${b.eventId}  ${tail}`);
  }
}

function printNext(res) {
  const q = res.query;
  if (!res.next) { out(`No future "${q}" found ${res.from}..${res.searchedThrough}.`); return; }
  const e = res.next; const d = res.detail || {};
  const wl = d.waitlistedUsers != null ? ` · waitlist ${d.waitlistedUsers}` : '';
  const win = d.bookableNow === false ? ` · booking opens ${d.bookableFrom}` : d.bookableNow ? ' · bookable now' : '';
  out(`Next "${q}": ${e.weekday} ${e.date} ${e.time}-${e.end} · ${e.title} · ${e.studio} · ${e.instructors.join(', ') || '-'} · ${spotsText(e)}${wl}${win}\n  ${e.id}`);
  if (res.nextWithSpots && !res.sameEvent) { const s = res.nextWithSpots; out(`Next with spots: ${s.weekday} ${s.date} ${s.time} · ${s.title} · ${s.instructors.join(', ') || '-'} · ${spotsText(s)}\n  ${s.id}`); }
  else if (!res.nextWithSpots) out(`No occurrence with spots through ${res.searchedThrough}.`);
}

function printInstructor(res) {
  if (!res.count) {
    out(`No sessions by "${res.name}" ${res.from}..${res.to} (${res.instructorsSeen} instructors seen).`);
    if (res.suggestions.length) out(`Did you mean: ${res.suggestions.join(', ')}?`);
    return;
  }
  const byDay = new Map();
  for (const e of res.sessions) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e); }
  for (const [date, evs] of byDay) { out(`\n${evs[0].weekday} ${date} · ${res.name} · ${evs.length} sessions`); for (const e of evs) out(line(e, true)); }
  out(`\n${res.count} sessions ${res.from}..${res.to}`);
}

function usage() { out('altea <login|status|rules|meta|actions|schedule|find|next|who|event|bookings|book|cancel|waitlist> …  (see header of bin/altea.mjs)'); }

const filterFlags = () => ({ instructor: flags.instructor, type: flags.type, studio: flags.studio, query: flags.query, availableOnly: !!flags.available, mine: !!flags.mine, after: flags.after, before: flags.before, at: flags.at, near: flags.near, timeOfDay: flags.tod });

async function main() {
  if (!cmd || flags.help) return usage();
  if (cmd === 'login') { await login({ log: (m) => process.stderr.write(m + '\n') }); return; }
  if (cmd === 'rules') return out({ ...RULES, note: 'cancel ≥ 8 h before start or pay the late fee; booking opens 48 h before start' });

  const client = new Altea({ log, windowMode: flags.window || (flags.headed ? 'visible' : undefined) });
  await client.init();
  try {
    switch (cmd) {
      case 'status': return out(await client.status());
      case 'meta': return out(await client.meta({ refresh: !!flags.refresh }));
      case 'actions': return out(await client.ensureActions({ force: !!flags.refresh }));
      case 'schedule': {
        const res = await client.schedule({ date: rest[0] || flags.date || 'today', days: Number(flags.days || 1), group: groupArg, community: flags.community, withDescription: !!flags.desc, nocache: !!flags.nocache, ...filterFlags() });
        return flags.json ? out(res) : printSchedule(res);
      }
      case 'find': {
        const res = await client.find({ query: rest.join(' ') || flags.query, from: flags.from || flags.date || 'today', days: Number(flags.days || 7), group: groupArg || ALL_GROUPS, community: flags.community, ...filterFlags(), query: rest.join(' ') || flags.query });
        return flags.json ? out(res) : printSchedule(res);
      }
      case 'next': {
        const res = await client.next({ query: rest.join(' ') || flags.query, instructor: flags.instructor, type: flags.type, studio: flags.studio, from: flags.from || flags.date || 'today', days: Number(flags.days || 14), group: groupArg || ALL_GROUPS, community: flags.community });
        return flags.json ? out(res) : printNext(res);
      }
      case 'who': case 'instructor': {
        const res = await client.instructor({ name: rest[0], date: rest[1] || flags.date || 'today', days: Number(flags.days || 1), group: groupArg || ALL_GROUPS, community: flags.community });
        return flags.json ? out(res) : printInstructor(res);
      }
      case 'event': {
        const res = await client.event(rest[0]);
        if (flags.json) return out(res);
        const e = res.event;
        out(`${e.title}\n${e.weekday} ${e.date} ${e.time}-${e.end} (${e.duration} min) · ${e.studio} · ${e.community}\nInstructors: ${e.instructors.join(', ') || '-'} · Types: ${e.types.join(', ') || '-'} · Spots left: ${e.spotsLeft}${e.full ? ' (FULL)' : ''}\n${e.description ? e.description + '\n' : ''}`);
        out(res.myBooking ? `My booking: ${res.myBooking.bookingId} ${res.myBooking.status} · free-cancel deadline ${res.myBooking.cancellation?.deadline}${res.myBooking.cancellation?.late ? ' (LATE now: fee ' + (res.myBooking.cancellation.feeText ?? 'applies') + ')' : ''}` : 'Not booked.');
        if (res.bookingWindow && !res.options.length) out(`Booking: ${res.bookingWindow.bookableNow ? 'open now' : 'opens ' + res.bookingWindow.bookableFrom} (48 h rule; no membership option offered yet)`);
        for (const o of res.options) out(`Option: ${o.title} · ${o.unlimited ? 'unlimited' : `$${(o.price / 100).toFixed(2)}`} · booking ${o.bookableNow ? 'open now' : 'opens ' + o.bookableFrom} (${o.bookingWindowMin / 60} h window) · cancel ${o.cancellation?.text ?? '?'}${o.cancellation?.feeText && !/\$/.test(o.cancellation?.text || '') ? ' or ' + o.cancellation.feeText : ''}${o.disabled ? ' (disabled)' : ''}`);
        if (res.unsignedAgreements.length) out(`UNSIGNED agreements: ${res.unsignedAgreements.join(', ')}`);
        if (res.conflicts.length) out(`Conflicts: ${JSON.stringify(res.conflicts)}`);
        out(`Payment methods: ${res.paymentMethods.map((p) => `${p.label}${p.default ? ' (default)' : ''}${p.expired ? ' EXPIRED' : ''}`).join(', ') || 'none'} · waitlist: ${res.waitlistedUsers} people${res.waitlistPosition ? `, my position ${res.waitlistPosition}` : ''}`);
        return;
      }
      case 'bookings': {
        const res = await client.bookings({ from: flags.from || flags.date || 'today', to: flags.to, days: Number(flags.days || 30) });
        return flags.json ? out(res) : printBookings(res);
      }
      case 'book': { if (!rest[0]) throw new Error('book <evt_id>'); return out(await client.book({ eventId: rest[0], force: !!flags.force, perkId: flags.perk, paymentMethodId: flags.pm })); }
      case 'cancel': {
        if (!rest[0]) throw new Error('cancel <bkg_id|evt_id>');
        const id = rest[0];
        return out(await client.cancel(id.startsWith('bkg_') ? { bookingId: id, eventId: flags.event, force: !!flags.force } : { eventId: id, force: !!flags.force }));
      }
      case 'waitlist': { const [action, eventId] = rest; return out(await client.waitlist({ eventId, action })); }
      default: return usage();
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  if (e instanceof NotSignedIn) { process.stderr.write(`not signed in: ${e.message}\n`); process.exit(2); }
  process.stderr.write(`error: ${flags.verbose ? (e.stack || e.message) : e.message}\n`);
  process.exit(1);
});
