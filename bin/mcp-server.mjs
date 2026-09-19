#!/usr/bin/env node
// altea MCP server (stdio). Exposes the Altea Active booking app to Claude.
// Register:  claude mcp add -s user altea -- node /Users/noorabdalla/Projects/altea-mcp/bin/mcp-server.mjs
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Altea, RULES } from '../src/client.mjs';
import { NotSignedIn } from '../src/session.mjs';

const log = (m) => process.stderr.write(`[altea-mcp] ${m}\n`);
let client = null;
let lastUse = Date.now();
async function getClient() {
  if (!client) { client = new Altea({ log }); await client.init(); }
  lastUse = Date.now();
  return client;
}
// Close any Chrome window after 10 idle minutes (cookies are exported on close).
setInterval(async () => {
  if (client?.browser && Date.now() - lastUse > 10 * 60_000) { log('idle: closing chrome'); await client.close().catch(() => {}); client = null; }
}, 60_000).unref();

const text = (x) => ({ content: [{ type: 'text', text: typeof x === 'string' ? x : JSON.stringify(x, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e instanceof NotSignedIn ? `NOT_SIGNED_IN: ${e.message}` : `ERROR: ${e.message || e}` }] });
const run = (fn) => async (args) => {
  try { return text(await fn(await getClient(), args || {})); }
  catch (e) {
    log(`error: ${e.stack || e}`);
    // A stale/empty cookie jar must not be cached for the life of the server: drop the client so
    // the next call re-reads ~/.altea/cookies.json (written by `altea login`).
    if (e instanceof NotSignedIn && client) { const c = client; client = null; await c.close().catch(() => {}); }
    return fail(e);
  }
};

const server = new McpServer({ name: 'altea', version: '0.2.0' });

const RULE_TEXT = 'Membership rules: cancel at least 8 h before start or a late fee applies; booking opens 48 h before start.';
const dateDesc = 'YYYY-MM-DD | today | tomorrow | mon..sun (next such day, today included) | "next mon" | +N days. Toronto time.';
const timeDesc = '24h HH:MM or "3pm" / "3:30pm".';
const groupDesc = 'Calendar group: "Boutique Fitness" (default for plain schedules), "Pickleball", "Aquatics", "Recovery & Wellness", "Personalized Performance", "Active Kids Club", or "all" to search every group of the club (use "all" whenever the question is not obviously about studio classes, e.g. courts, instructors, recovery).';
const filterShape = {
  instructor: z.string().optional().describe('Instructor name or first name, e.g. "Timo", "Omar".'),
  type: z.string().optional().describe('Event-type tag substring: Cycle, HIIT, Barre, Boxing, Hot Yoga, Hyrox, LF3, LF3 Strength, LF3 Tread, Mobility, Pilates, Reformer Pilates, Strength, Yoga.'),
  studio: z.string().optional().describe('Studio / calendar substring, e.g. "Cycle Studio", "Reformer", "Pickleball Courts".'),
  query: z.string().optional().describe('Free-text words matched over title, studio, instructors, types (all words must match).'),
  availableOnly: z.boolean().optional().describe('Only events with spots left ("open", "available").'),
  mine: z.boolean().optional().describe('Only events I am booked into or waitlisted for.'),
  after: z.string().optional().describe('Earliest start time. ' + timeDesc),
  before: z.string().optional().describe('Latest start time. ' + timeDesc),
  at: z.string().optional().describe('A clock time; matches events in progress at that time (start ≤ at < end), e.g. "3pm" for a 3 pm court. ' + timeDesc),
  near: z.number().optional().describe('With `at`: instead match events starting within ± this many minutes of `at`.'),
  timeOfDay: z.enum(['morning', 'lateMorning', 'afternoon', 'lateAfternoon', 'evening', 'night']).optional().describe('App bands: morning 0-9, lateMorning 9-12, afternoon 12-15, lateAfternoon 15-18, evening 18-21, night 21-24.'),
};
const scheduleShape = {
  date: z.string().optional().describe(dateDesc),
  days: z.number().int().min(1).max(45).optional().describe('Consecutive days from `date` (default 1). Fetched in parallel.'),
  group: z.string().optional().describe(groupDesc),
  community: z.string().optional().describe('Club name or com_ id. Default Altea Ottawa.'),
  withDescription: z.boolean().optional().describe('Include class descriptions (bigger output).'),
  ...filterShape,
};

server.tool('altea_status', 'Session health for myaltea.app: signed in?, cookies, discovered server-action ids, membership rules. Call first if another altea tool returns NOT_SIGNED_IN.', {}, run((c) => c.status()));

server.tool('altea_schedule', 'Altea class / court / session schedule for one or more days with spots left, instructors, studio and my booking status. Each event has an id (evt_…) used by altea_event / altea_book. Supports time filters (`at` "3pm", `after`, `before`), instructor/type/studio/query filters, availability, and group "all". Reads only.', scheduleShape, run((c, a) => c.schedule(a)));

server.tool('altea_find', 'Search upcoming events across ALL calendar groups (default) for the next N days (default 7) by words in title / instructor / type / studio, with the same filters as altea_schedule. Returns a flat event list. Reads only.', {
  query: z.string().describe('Words to match, e.g. "main stage ride", "hot yin", "court 1", "reformer level 2".'),
  from: z.string().optional().describe(dateDesc), days: z.number().int().min(1).max(45).optional(),
  group: z.string().optional().describe(groupDesc + ' Default "all".'), community: scheduleShape.community,
  availableOnly: filterShape.availableOnly, instructor: filterShape.instructor, type: filterShape.type, studio: filterShape.studio, after: filterShape.after, before: filterShape.before, at: filterShape.at, near: filterShape.near, timeOfDay: filterShape.timeOfDay,
}, run((c, a) => c.find(a)));

server.tool('altea_next', 'The NEXT future occurrence of a class / activity / instructor (e.g. "next Hot Yin", "next Main Stage Ride", "next class with Sara"): returns the first upcoming match, the first one that still has spots, waitlist size, whether it is bookable now (48 h window) and the cancel deadline. Searches all groups, 14 days by default. Reads only.', {
  query: z.string().optional().describe('Words in the title, e.g. "hot yin".'),
  instructor: filterShape.instructor, type: filterShape.type, studio: filterShape.studio,
  from: z.string().optional().describe(dateDesc), days: z.number().int().min(1).max(45).optional(),
  group: z.string().optional().describe(groupDesc + ' Default "all".'), community: scheduleShape.community,
}, run((c, a) => c.next(a)));

server.tool('altea_instructor', 'Everything a given instructor teaches on a date (or range), across ALL calendar groups. Returns their sessions with spots, plus "did you mean" name suggestions when nothing matches. Reads only.', {
  name: z.string().describe('Instructor name or first name, e.g. "Omar".'),
  date: z.string().optional().describe(dateDesc), days: z.number().int().min(1).max(45).optional().describe('Range length (default 1).'),
  group: z.string().optional().describe(groupDesc + ' Default "all".'), community: scheduleShape.community,
}, run((c, a) => c.instructor(a)));

server.tool('altea_event', 'Details for one event: description, spots, instructors, my booking (bookingId + free-cancel deadline / fee), membership options and a bookingWindow summary (bookableFrom / bookableNow, 48 h rule), conflicts, unsigned waivers, waitlist size. Reads only.', { eventId: z.string().describe('evt_… id from altea_schedule / altea_find / altea_next') }, run((c, a) => c.event(a.eventId)));

server.tool('altea_bookings', 'My upcoming (or past) bookings with bookingId, status, canCancel, the free-cancellation deadline (start − 8 h) and whether cancelling now would be late (fee). Reads only.', {
  from: z.string().optional().describe(dateDesc + ' Default today.'), to: z.string().optional().describe('End date (inclusive).'), days: z.number().int().min(1).max(120).optional().describe('Range length when `to` is absent (default 30).'),
}, run((c, a) => c.bookings(a)));

server.tool('altea_book', `BOOK a spot in an event for the signed-in member (a real reservation). ${RULE_TEXT} Uses the default unlimited membership and the default card on file, exactly like the app; a Chrome window opens for ~4 s. Refuses when the booking window is not open yet (error says when it opens), a waiver is unsigned, there is a schedule conflict, or the event is full (use altea_waitlist), unless force=true. Confirm intent with the user first unless they explicitly asked to book.`, {
  eventId: z.string(), force: z.boolean().optional().describe('Override window/conflict/full checks.'), perkId: z.string().optional().describe('prk_… to pick a specific membership option'), paymentMethodId: z.string().optional().describe('pm_… to pick a specific card'),
}, run((c, a) => c.book(a)));

server.tool('altea_cancel', `CANCEL one of my bookings by bookingId (bkg_…) or eventId (evt_…). ${RULE_TEXT} Refuses a late cancellation (inside the 8 h window → fee) unless force=true; the error states the deadline and fee. Confirm intent with the user first unless they explicitly asked to cancel.`, {
  bookingId: z.string().optional(), eventId: z.string().optional(), force: z.boolean().optional(),
}, run((c, a) => c.cancel(a)));

server.tool('altea_waitlist', 'Join or leave the waitlist of a full event (join opens a Chrome window for ~4 s). Returns my waitlist position and the waitlist size.', { eventId: z.string(), action: z.enum(['join', 'leave']) }, run((c, a) => c.waitlist(a)));

server.tool('altea_meta', 'Reference data: clubs (communities) with their calendar groups, event-type tags, instructor list, membership rules. Cached 7 days; refresh=true to refetch.', { refresh: z.boolean().optional() }, run((c, a) => c.meta(a)));

server.tool('altea_actions', 'Discover/refresh the current build\'s server-action ids (book/cancel/waitlist). Run with refresh=true if book/cancel start failing after an app deploy.', { refresh: z.boolean().optional() }, run((c, a) => c.ensureActions({ force: !!a.refresh })));

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready (rules: cancel ${RULES.cancelWindowMin / 60} h, book ${RULES.bookingWindowMin / 60} h)`);
process.on('SIGTERM', async () => { await client?.close().catch(() => {}); process.exit(0); });
process.on('SIGINT', async () => { await client?.close().catch(() => {}); process.exit(0); });
