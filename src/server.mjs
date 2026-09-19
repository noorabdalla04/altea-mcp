// The MCP server, transport-agnostic. `createAlteaServer()` returns an McpServer wired to an Altea client
// (injectable for tests). Design record: docs/mcp-design.md.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Altea, RULES } from './client.mjs';

const MEMBER = process.env.ALTEA_MEMBER_NAME || 'the member';
import { toAlteaError, withTimeout, Mutex } from './errors.mjs';
import { renderSchedule, renderFind, renderInstructor, renderNext, renderEvent, renderBookings, renderAction } from './format.mjs';

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

export const INSTRUCTIONS = `Altea Active booking assistant for ${MEMBER} (times are in the club's local time zone; the default club is the member's home club).
Membership rules: (1) cancel at least ${RULES.cancelWindowMin / 60} hours before a session starts or a late fee applies; (2) booking opens ${RULES.bookingWindowMin / 60} hours before start.
Defaults: the member's home club, calendar group "Boutique Fitness" for plain class questions. Use group "all" for instructor questions, courts (Pickleball), recovery, aquatics, or anything not obviously a studio class.
Sequencing: altea_find / altea_next / altea_schedule give event ids → altea_event shows the booking window, conflicts and my booking → altea_book / altea_cancel / altea_waitlist act. altea_bookings lists what is booked with free-cancel deadlines.
Policy: book, cancel or join a waitlist only when ${MEMBER} asked for it; for a question, answer first and offer. altea_cancel refuses late cancellations and altea_book refuses closed windows, full events, conflicts, paid options and unsigned waivers; pass force only after ${MEMBER} explicitly confirms (force never bypasses waivers or paid options). Never sign waivers, add payment cards or invite guests on the member's behalf. altea_book and waitlist join run inside a hidden Chrome window (no visible window in normal operation; if the backend refuses the hidden window the call retries once with a visible one, so warn only if that happens: the result field via says page:visible).
Results: default format is concise text plus structured data; use format "detailed" when you need ids, urls or descriptions for a follow-up call. Errors come back as ERROR[CODE] with whether a retry is safe and the next valid action. NOT_SIGNED_IN means ${MEMBER} must run the login command once.`;

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const ADDITIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

const dateDesc = 'YYYY-MM-DD | today | tomorrow | mon..sun (next such day, today included) | "next mon" | +N days | "this week" / "next week" / "weekend" (ranges; they set days). Club local time.';
const timeDesc = '24h "15:00" or "3pm" / "3:30pm".';
const groupDesc = 'Calendar group: "Boutique Fitness" (default for plain class schedules), "Pickleball", "Aquatics", "Recovery & Wellness", "Personalized Performance", "Active Kids Club", or "all" for every group of the club. Use "all" for instructor questions, courts, recovery, or anything not obviously a studio class.';
const formatField = z.enum(['concise', 'detailed']).optional().describe('concise (default): short text lines + minimal structured list. detailed: full event objects with ids, urls, instructor ids, descriptions — use only when a follow-up call needs them.');
const limitField = z.number().int().min(1).max(200).optional().describe('Max events per day in the result (default 60); a truncation note tells you when more exist.');
const filterShape = {
  instructor: z.string().optional().describe('Instructor name or first name, substring match, e.g. "Timo", "X".'),
  type: z.string().optional().describe('Event-type tag substring: Cycle, HIIT, Barre, Boxing, Hot Yoga, Hyrox, LF3, LF3 Strength, LF3 Tread, Mobility, Pilates, Reformer Pilates, Strength, Yoga.'),
  studio: z.string().optional().describe('Studio / calendar substring, e.g. "Cycle Studio", "Reformer", "Pickleball Courts", "Recovery Lounge".'),
  query: z.string().optional().describe('Free-text words matched over title, studio, instructors and types; every word must match.'),
  availableOnly: z.boolean().optional().describe('Only events with spots left ("open", "available").'),
  mine: z.boolean().optional().describe('Only events I am booked into or waitlisted for.'),
  after: z.string().optional().describe('Earliest start time. ' + timeDesc),
  before: z.string().optional().describe('Latest start time. ' + timeDesc),
  at: z.string().optional().describe('A clock time; matches events in progress then (start ≤ at < end), e.g. "3pm" for a 3 pm court. ' + timeDesc),
  near: z.number().int().min(0).max(240).optional().describe('With `at`: instead match events starting within ± this many minutes of `at`.'),
  timeOfDay: z.enum(['morning', 'lateMorning', 'afternoon', 'lateAfternoon', 'evening', 'night']).optional().describe('App bands: morning 0-9, lateMorning 9-12, afternoon 12-15, lateAfternoon 15-18, evening 18-21, night 21-24.'),
};

// ---- output shapes (validated by the SDK; passthrough keeps `detailed` extras) ----
// Events appear compact ({id,time,title,studio,spots,who}) in concise mode and fuller in detailed mode; keep the schema permissive.
const EventOut = z.object({ id: z.string(), title: z.string(), time: z.string().nullable().optional(), studio: z.string().nullable().optional(), spots: z.union([z.number(), z.string()]).nullable().optional(), who: z.string().optional(), group: z.string().optional(), date: z.string().nullable().optional(), end: z.string().nullable().optional(), instructors: z.array(z.string()).optional(), spotsLeft: z.number().nullable().optional(), full: z.boolean().optional(), myStatus: z.string().nullable().optional(), waitlisted: z.boolean().optional() }).passthrough();
const Status = z.enum(['success', 'warning', 'error']);
const SeriesOut = z.object({ title: z.string(), studio: z.string().nullable(), from: z.string().nullable(), to: z.string().nullable(), count: z.number(), withSpots: z.number(), nextOpen: EventOut.nullable(), openTimes: z.array(z.string()).optional(), mine: z.array(EventOut).optional() }).passthrough();
const DayOut = z.object({ date: z.string(), weekday: z.string(), count: z.number(), events: z.array(EventOut), series: z.array(SeriesOut).optional(), truncated: z.number().optional(), note: z.string().optional(), errors: z.array(z.string()).optional() });
const scheduleOut = { status: Status, summary: z.string(), from: z.string(), to: z.string(), groups: z.array(z.string()), count: z.number(), days: z.array(DayOut) };
const findOut = { ...scheduleOut, events: z.array(EventOut) };
const instructorOut = { status: Status, summary: z.string(), name: z.string(), matchedNames: z.array(z.string()).optional(), from: z.string(), to: z.string(), count: z.number(), sessions: z.array(EventOut), truncated: z.number().optional(), suggestions: z.array(z.string()) };
const nextOut = { status: Status, summary: z.string(), query: z.string(), from: z.string(), searchedThrough: z.string(), next: EventOut.nullable(), nextWithSpots: EventOut.nullable(), sameEvent: z.boolean().optional(), waitlistedUsers: z.number().nullable().optional(), bookableNow: z.boolean().nullable().optional(), bookableFrom: z.string().nullable().optional(), cancelBy: z.string().nullable().optional(), myBooking: z.any().optional() };
const Policy = z.object({ enabled: z.boolean().optional(), windowHours: z.number().nullable().optional(), feeCents: z.number().nullable().optional(), feeText: z.string().nullable().optional(), deadline: z.string().nullable().optional(), late: z.boolean().nullable().optional(), text: z.string().nullable().optional(), source: z.string().optional() }).passthrough();
const eventOut = { status: Status, summary: z.string(), id: z.string(), event: EventOut.nullable(), myBooking: z.object({ bookingId: z.string(), status: z.string().nullable().optional(), perk: z.string().nullable().optional(), cancellation: Policy.nullable().optional() }).passthrough().nullable(), bookingWindow: z.object({ bookableFrom: z.string().nullable(), bookableNow: z.boolean().nullable(), source: z.string(), usableOptions: z.number() }).nullable(), cancellation: Policy.nullable(), options: z.array(z.object({ title: z.string().nullable().optional(), price: z.number().optional(), unlimited: z.boolean().optional(), disabled: z.boolean().optional(), bookableFrom: z.string().nullable().optional(), bookableNow: z.boolean().nullable().optional() }).passthrough()), unsignedAgreements: z.array(z.string()), conflicts: z.array(z.any()), waitlistedUsers: z.number(), waitlistPosition: z.number() };
const bookingsOut = { status: Status, summary: z.string(), from: z.string(), to: z.string(), count: z.number(), bookings: z.array(z.object({ bookingId: z.string().nullable(), eventId: z.string().nullable(), date: z.string().nullable(), time: z.string().nullable(), title: z.string().nullable(), studio: z.string().nullable(), instructors: z.array(z.string()), status: z.string().nullable(), waitlisted: z.boolean(), canCancel: z.boolean(), cancelBy: z.string().nullable(), late: z.boolean().nullable(), fee: z.string().nullable() }).passthrough()), pastCounts: z.record(z.number()).optional() };
const actionOut = { status: Status, summary: z.string(), ok: z.boolean(), via: z.string().optional(), alreadyBooked: z.boolean().optional(), alreadyCancelled: z.boolean().optional(), bookingId: z.string().nullable(), eventId: z.string().nullable(), cancelBy: z.string().nullable(), waitlistPosition: z.number().nullable(), event: EventOut.nullable(), serverError: z.any().nullable() };
const statusOut = { status: Status, summary: z.string(), signedIn: z.boolean(), userId: z.string().nullable(), cookies: z.number(), sessionExpiresAt: z.string().nullable().optional(), defaultCommunity: z.string().nullable().optional(), actions: z.any().nullable(), windowMode: z.string().optional(), rules: z.object({ cancelWindowMin: z.number(), bookingWindowMin: z.number() }), version: z.string() };
const metaOut = { status: Status, summary: z.string(), communities: z.array(z.object({ id: z.string(), name: z.string(), groups: z.array(z.string()), timezone: z.string().nullable().optional() })), types: z.array(z.string()), instructors: z.array(z.string()), rules: z.object({ cancelWindowMin: z.number(), bookingWindowMin: z.number() }) };
const actionsOut = { status: Status, summary: z.string(), actions: z.record(z.string()) };

/**
 * @param {object} o
 * @param {() => object} [o.makeClient]  factory for the Altea client (tests inject a stub)
 */
export function createAlteaServer({ makeClient, log = (m) => process.stderr.write(`[altea-mcp] ${m}\n`), readTimeoutMs = 60_000, actionTimeoutMs = 150_000, idleMs = 10 * 60_000 } = {}) {
  const factory = makeClient || (() => new Altea({ log }));
  let client = null; let lastUse = Date.now();
  const mutex = new Mutex();
  async function getClient() { if (!client) { client = factory(); if (client.init) await client.init(); } lastUse = Date.now(); return client; }
  const idle = setInterval(async () => { if (client?.browser && Date.now() - lastUse > idleMs) { log('idle: closing chrome'); await client.close().catch(() => {}); client = null; } }, 60_000);
  idle.unref();

  const ok = ({ text, structured }) => ({ content: [{ type: 'text', text }], structuredContent: structured });
  const fail = (e) => { const err = toAlteaError(e); return { isError: true, content: [{ type: 'text', text: `ERROR[${err.code}]: ${err.message}\nRetry safe: ${err.retryable ? 'yes' : 'no'}. Next: ${err.next}${err.details ? `\nDetails: ${JSON.stringify(err.details)}` : ''}` }] }; };
  const run = (fn, { timeout = readTimeoutMs, exclusive = false } = {}) => async (args) => {
    try {
      const c = await getClient();
      const work = () => Promise.resolve(fn(c, args || {}));
      // exclusive: the mutex is held until the work settles, even if this caller times out first
      return ok(await withTimeout(exclusive ? mutex.run(work) : work(), timeout, 'tool call'));
    } catch (e) {
      log(`error: ${e?.code || ''} ${e?.message || e}`);
      if (e?.name === 'NotSignedIn' && client) { const c = client; client = null; await c.close().catch(() => {}); } // re-read the jar next time
      return fail(e);
    }
  };

  const server = new McpServer({ name: 'altea', version: pkg.version, title: 'Altea Active booking' }, { instructions: INSTRUCTIONS });

  // ---------------- tools (deterministic order: status, reads, writes, reference) ----------------
  server.registerTool('altea_status', {
    title: 'Altea session status',
    description: 'Checks whether the saved myaltea.app session is valid and reports the membership rules, discovered server-action ids and server version. Use it when another altea tool returned NOT_SIGNED_IN, or once at the start of a booking task to confirm the account is live. Read-only, ~1 s. It does not list classes; use altea_schedule for that.',
    inputSchema: {}, outputSchema: statusOut, annotations: READ,
  }, run(async (c) => { const s = await c.status(); const summary = s.signedIn ? `Signed in${s.defaultCommunity ? ` at ${s.defaultCommunity}` : ''}${s.sessionExpiresAt ? `; session cookie expires ${s.sessionExpiresAt.slice(0, 10)}` : ''}; rules: cancel ≥ ${s.rules.cancelWindowMin / 60} h before, booking opens ${s.rules.bookingWindowMin / 60} h before; window mode ${s.windowMode}.` : `Not signed in: ${s.error}`; return { text: summary, structured: { status: s.signedIn ? 'success' : 'warning', summary, signedIn: s.signedIn, userId: s.userId ?? null, cookies: s.cookies, sessionExpiresAt: s.sessionExpiresAt ?? null, defaultCommunity: s.defaultCommunity ?? null, actions: s.actions ?? null, windowMode: s.windowMode, rules: s.rules, version: pkg.version } }; }));

  server.registerTool('altea_schedule', {
    title: 'Altea schedule for a day or range',
    description: 'Lists sessions (classes, courts, recovery slots) for one day or several consecutive days with time, studio, instructor, spots left and whether the member is booked. Use it for "what\'s on tomorrow", "courts open at 3 pm", "evening classes this Saturday", or any question about a specific date. Combine filters freely: instructor, type, studio, query, availableOnly, after/before, `at` (in progress at a clock time), timeOfDay. Defaults to the Boutique Fitness group at the home club; pass group "all" for courts, recovery or instructor questions. Not for "the next occurrence of X" (use altea_next) or for searching many days by words (use altea_find). Cost ≈ 1.5 s per day per group; all groups ≈ 2 s per day.',
    inputSchema: { date: z.string().optional().describe(dateDesc), days: z.number().int().min(1).max(45).optional().describe('Consecutive days from `date` (default 1).'), group: z.string().optional().describe(groupDesc), community: z.string().optional().describe('Club name or com_ id; default: the member\'s home club.'), ...filterShape, format: formatField, limit: limitField },
    outputSchema: scheduleOut, annotations: READ,
  }, run(async (c, a) => { const { format, limit, ...rest } = a; return renderSchedule(await c.schedule({ ...rest, withDescription: format === 'detailed' }), { format, limit }); }));

  server.registerTool('altea_find', {
    title: 'Search Altea sessions by words',
    description: 'Searches every calendar group (by default) over the next N days (default 7) for sessions whose title, studio, instructor or type contains all the given words, e.g. "main stage ride", "reformer level 2", "court 1", "massage chair". Use it to turn a name the member mentions into event ids and dates before altea_event or altea_book, or to answer "is there any X this week". Same filters as altea_schedule. For the single next occurrence prefer altea_next; for one known date prefer altea_schedule.',
    inputSchema: { query: z.string().min(1).describe('Words to match, e.g. "hot yin", "main stage ride", "advanced court 1".'), from: z.string().optional().describe(dateDesc + ' Default today.'), days: z.number().int().min(1).max(45).optional().describe('Range length (default 7).'), group: z.string().optional().describe(groupDesc + ' Default "all".'), community: z.string().optional(), instructor: filterShape.instructor, type: filterShape.type, studio: filterShape.studio, availableOnly: filterShape.availableOnly, after: filterShape.after, before: filterShape.before, at: filterShape.at, near: filterShape.near, timeOfDay: filterShape.timeOfDay, format: formatField, limit: limitField },
    outputSchema: findOut, annotations: READ,
  }, run(async (c, a) => { const { format, limit, ...rest } = a; return renderFind(await c.find(rest), { format, limit }); }));

  server.registerTool('altea_next', {
    title: 'Next occurrence of a class, activity or instructor',
    description: 'Finds the next future session matching words in the title (and/or an instructor, type or studio), searching all groups up to 14 days ahead. Returns the first match with spots left or FULL, the waitlist size, whether it is bookable now (48 h window) and the free-cancel deadline, plus the first later occurrence that still has spots when the next one is full. Use for "how many spots in the next Hot Yin", "when is the next Main Stage Ride", "next class with Sara". Not for a full day listing (altea_schedule) or for a specific known date.',
    inputSchema: { query: z.string().optional().describe('Words in the title, e.g. "hot yin".'), instructor: filterShape.instructor, type: filterShape.type, studio: filterShape.studio, from: z.string().optional().describe(dateDesc + ' Default today.'), days: z.number().int().min(1).max(45).optional().describe('How far ahead to search (default 14).'), group: z.string().optional().describe(groupDesc + ' Default "all".'), community: z.string().optional(), format: formatField },
    outputSchema: nextOut, annotations: READ,
  }, run(async (c, a) => { const { format, ...rest } = a; return renderNext(await c.next(rest), { format }); }));

  server.registerTool('altea_instructor', {
    title: 'Sessions taught by an instructor',
    description: 'Everything a named instructor teaches on a date or over a range, across every calendar group (instructors appear in Boutique Fitness and Personalized Performance alike). Matches by substring on the name ("x", "timo c"); when nothing matches it returns "did you mean" suggestions from the instructors seen. Use for "which sessions does instructor X run on Monday", "anything with Timo this week". For a class name rather than a person use altea_find or altea_next.',
    inputSchema: { name: z.string().min(1).describe('Instructor name or first name, e.g. "X".'), date: z.string().optional().describe(dateDesc + ' Default today.'), days: z.number().int().min(1).max(45).optional().describe('Range length (default 1).'), group: z.string().optional().describe(groupDesc + ' Default "all".'), community: z.string().optional(), format: formatField, limit: limitField },
    outputSchema: instructorOut, annotations: READ,
  }, run(async (c, a) => { const { format, limit, ...rest } = a; return renderInstructor(await c.instructor(rest), { format, limit }); }));

  server.registerTool('altea_event', {
    title: 'One session in depth',
    description: 'Full detail for one event id: description, spots, instructors, whether the member is booked (with booking id and free-cancel deadline), the booking window (bookableFrom / bookableNow under the 48 h rule), membership options, schedule conflicts, unsigned waivers and waitlist size. Call it before altea_book or altea_cancel to know the consequences, or when the member asks "what is this class / can I book it yet". Needs an evt_… id from altea_schedule, altea_find or altea_next. Never cached.',
    inputSchema: { eventId: z.string().regex(/^evt_/).describe('evt_… id from altea_schedule / altea_find / altea_next'), format: formatField },
    outputSchema: eventOut, annotations: READ,
  }, run(async (c, a) => renderEvent(await c.event(a.eventId), { format: a.format })));

  server.registerTool('altea_bookings', {
    title: 'My Altea bookings',
    description: 'The member\'s upcoming bookings from a start date (default today) for the next N days (default 30): booking id, event id, time, studio, status, waitlist flag, whether it can be cancelled, the free-cancellation deadline (start − 8 h) and whether cancelling now would already be late with a fee. Use for "what am I booked into", before any cancel, or to warn about deadlines. Past days are only counted (the app keeps no past details). Reads only.',
    inputSchema: { from: z.string().optional().describe(dateDesc + ' Default today.'), to: z.string().optional().describe('End date inclusive (YYYY-MM-DD or relative).'), days: z.number().int().min(1).max(120).optional().describe('Range length when `to` is absent (default 30).') },
    outputSchema: bookingsOut, annotations: READ,
  }, run(async (c, a) => renderBookings(await c.bookings(a))));

  server.registerTool('altea_book', {
    title: 'Book a session',
    description: `Books ${MEMBER} into an event (a real reservation on the membership, using the default unlimited option and the card on file exactly like the app; paid options are never chosen implicitly). Only call it when ${MEMBER} asked to book. It refuses, with a coded error, when the booking window has not opened (says when it opens), the event is full (offer altea_waitlist), there is a schedule conflict, only paid options exist, or a waiver is unsigned; force=true overrides the window/conflict/full checks after explicit confirmation and never the waiver or paid-option checks. Idempotent: an already-booked event returns alreadyBooked. Runs in a hidden Chrome window (~5-8 s); only if the backend refuses that does it retry with a visible window (result field via = page:visible). Returns the booking id and the free-cancel deadline.`,
    inputSchema: { eventId: z.string().regex(/^evt_/).describe('evt_… id.'), force: z.boolean().optional().describe('Override window/conflict/full checks. Only after the member confirms.'), perkId: z.string().optional().describe('prk_… to pick a specific membership option, required for paid options.'), paymentMethodId: z.string().optional().describe('pm_… to pick a specific card (rare).') },
    outputSchema: actionOut, annotations: ADDITIVE,
  }, run(async (c, a) => renderAction('book', await c.book(a)), { timeout: actionTimeoutMs, exclusive: true }));

  server.registerTool('altea_cancel', {
    title: 'Cancel a booking',
    description: `Cancels one of ${MEMBER}'s bookings by booking id (bkg_…) or event id (evt_…). Only call it when ${MEMBER} asked to cancel. Always checks the policy first; refuses a late cancellation (inside the window, fee applies) with the deadline and fee in the error; force=true cancels anyway after explicit confirmation. Idempotent: an event that is not booked returns alreadyCancelled. Runs in under a second without a browser window.`,
    inputSchema: { bookingId: z.string().regex(/^bkg_/).optional().describe('bkg_… from altea_bookings / altea_event.'), eventId: z.string().regex(/^evt_/).optional().describe('evt_… (used to look up the booking and the policy).'), force: z.boolean().optional().describe('Cancel even if late (fee). Only after the member confirms.') },
    outputSchema: actionOut, annotations: DESTRUCTIVE,
  }, run(async (c, a) => renderAction('cancel', await c.cancel(a)), { timeout: actionTimeoutMs, exclusive: true }));

  server.registerTool('altea_waitlist', {
    title: 'Join or leave a waitlist',
    description: `Joins (action "join") or leaves (action "leave") the waitlist of a full event for ${MEMBER}, returning the position and the waitlist size. Use join when a wanted class is FULL and ${MEMBER} agrees; use leave to undo. Joining runs in a hidden Chrome window (~5 s); leaving is instant. Joining does not book a spot; the club promotes waitlisted members when a spot frees up.`,
    inputSchema: { eventId: z.string().regex(/^evt_/), action: z.enum(['join', 'leave']) },
    outputSchema: actionOut, annotations: ADDITIVE,
  }, run(async (c, a) => renderAction(a.action, await c.waitlist(a)), { timeout: actionTimeoutMs, exclusive: true }));

  server.registerTool('altea_meta', {
    title: 'Reference data',
    description: 'Clubs (communities) with their calendar groups, event-type tags, the instructor list and the membership rules. Use it to resolve an unfamiliar group, type or instructor name before filtering, or to explain what exists. Cached for 7 days; refresh=true refetches. Reads only.',
    inputSchema: { refresh: z.boolean().optional() }, outputSchema: metaOut, annotations: READ,
  }, run(async (c, a) => { const m = await c.meta(a); const summary = `${m.communities.length} clubs, ${m.types.length} event types, ${m.instructors.length} instructors`; const text = [summary, ...m.communities.map((x) => `${x.name}: ${x.groups.join(', ')}`), `Types: ${m.types.map((t) => t.label).join(', ')}`, `Instructors: ${m.instructors.map((i) => i.name).join(', ')}`].join('\n'); return { text, structured: { status: 'success', summary, communities: m.communities.map((x) => ({ id: x.id, name: x.name, groups: x.groups, timezone: x.timezone ?? null })), types: m.types.map((t) => t.label), instructors: m.instructors.map((i) => i.name), rules: m.rules || RULES } }; }));

  server.registerTool('altea_actions', {
    title: 'Refresh server-action ids',
    description: 'Re-discovers the app\'s per-deploy server-action ids used by book / cancel / waitlist and caches them. Only needed when those tools fail with UNKNOWN_ACTION after an Altea redeploy. Touches no account data.',
    inputSchema: { refresh: z.boolean().optional().describe('true to force rediscovery.') }, outputSchema: actionsOut, annotations: READ,
  }, run(async (c, a) => { const actions = await c.ensureActions({ force: !!a.refresh }); const summary = `${Object.keys(actions).length} actions known (${['confirmBookingAction', 'cancelBookingAction', 'joinWaitlistAction', 'leaveWaitlistAction'].filter((k) => actions[k]).length}/4 booking actions)`; return { text: summary, structured: { status: 'success', summary, actions } }; }));

  // ---------------- resources ----------------
  server.registerResource('rules', 'altea://rules', { title: 'Altea membership rules', description: 'Cancellation and booking-window rules plus usage policy.', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: `# Altea membership rules (${MEMBER})\n- Cancel at least ${RULES.cancelWindowMin / 60} h before start, otherwise the late fee applies (the app states the fee per membership option).\n- Booking opens ${RULES.bookingWindowMin / 60} h before start (the app may report a slightly longer window for some options; the app's value wins).\n- Book / cancel / waitlist only on ${MEMBER}'s request; never sign waivers or add cards.\n` }] }));
  server.registerResource('meta', 'altea://meta', { title: 'Clubs, groups, types, instructors', description: 'Reference data as JSON.', mimeType: 'application/json' },
    async (uri) => { const c = await getClient(); const m = await c.meta(); return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ communities: m.communities, types: m.types.map((t) => t.label), instructors: m.instructors.map((i) => i.name), rules: m.rules || RULES }) }] }; });
  server.registerResource('upcoming-bookings', 'altea://bookings/upcoming', { title: 'My upcoming bookings', description: 'Bookings for the next 30 days with free-cancel deadlines.', mimeType: 'text/plain' },
    async (uri) => { const c = await getClient(); return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: renderBookings(await c.bookings({})).text }] }; });
  server.registerResource('schedule', new ResourceTemplate('altea://schedule/{date}', { list: undefined }), { title: 'Schedule for a date', description: 'Boutique Fitness schedule for a date (YYYY-MM-DD, today, tomorrow, mon..sun).', mimeType: 'text/plain' },
    async (uri, { date }) => { const c = await getClient(); return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: renderSchedule(await c.schedule({ date: String(date) })).text }] }; });

  // ---------------- prompts ----------------
  server.registerPrompt('altea-day-brief', { title: 'Gym day brief', description: `Summarise a day at Altea for ${MEMBER}: bookings, open spots, deadlines.`, argsSchema: { date: z.string().optional().describe(dateDesc) } },
    ({ date }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Give me a concise Altea brief for ${date || 'today'}: call altea_bookings for that day (flag any free-cancel deadline within the next 8 hours), then altea_schedule for ${date || 'today'} with group "all" and availableOnly true, and list the sessions worth knowing about (instructor, time, spots). End with one line on what I could still book (booking window) and ask nothing unless a decision is needed.` } }] }));
  server.registerPrompt('altea-book-request', { title: 'Handle a booking request', description: 'Turn a natural-language booking request into a safe, confirmed booking.', argsSchema: { request: z.string().describe('What the member asked for, e.g. "book me into the 9 am Main Stage Ride tomorrow".') } },
    ({ request }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Booking request: "${request}". Find the event with altea_find or altea_next, then altea_event to check the booking window, conflicts and waivers. Show me the exact session (time, studio, instructor, spots, free-cancel deadline) and wait for my yes. Only then call altea_book, and report the booking id and the cancel-by time. If it is full, offer altea_waitlist join instead.` } }] }));

  const shutdown = async () => { clearInterval(idle); if (client) await client.close().catch(() => {}); client = null; };
  return { server, shutdown, getClient };
}
