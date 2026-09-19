#!/usr/bin/env node
// altea MCP server (stdio). Exposes the Altea Active booking app to Claude.
// Register:  claude mcp add -s user altea -- node /Users/noorabdalla/Projects/altea-mcp/bin/mcp-server.mjs
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Altea, DEFAULT_GROUP, DEFAULT_COMMUNITY_ID } from '../src/client.mjs';
import { NotSignedIn } from '../src/session.mjs';

const log = (m) => process.stderr.write(`[altea-mcp] ${m}\n`);
let client = null;
let lastUse = Date.now();
async function getClient() {
  if (!client) { client = new Altea({ log }); await client.init(); }
  lastUse = Date.now();
  return client;
}
// Close the Chrome profile after 10 idle minutes (cookies are exported on close).
setInterval(async () => {
  if (client?.browser && Date.now() - lastUse > 10 * 60_000) { log('idle: closing chrome'); await client.close().catch(() => {}); client = null; }
}, 60_000).unref();

const text = (x) => ({ content: [{ type: 'text', text: typeof x === 'string' ? x : JSON.stringify(x, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e instanceof NotSignedIn ? `NOT_SIGNED_IN: ${e.message}` : `ERROR: ${e.message || e}` }] });
const run = (fn) => async (args) => {
  try { return text(await fn(await getClient(), args || {})); }
  catch (e) {
    log(`error: ${e.stack || e}`);
    // A stale/empty cookie jar must not be cached for the life of the server: drop the
    // client so the next call re-reads ~/.altea/cookies.json (written by `altea login`).
    if (e instanceof NotSignedIn && client) { const c = client; client = null; await c.close().catch(() => {}); }
    return fail(e);
  }
};

async function resolveCommunity(c, input) {
  if (!input) return DEFAULT_COMMUNITY_ID;
  if (input.startsWith('com_')) return input;
  const m = await c.meta();
  const hit = m.communities.find((x) => x.name.toLowerCase().includes(input.toLowerCase()));
  if (!hit) throw new Error(`unknown community "${input}"; known: ${m.communities.map((x) => x.name).join(', ')}`);
  return hit.id;
}
async function resolveGroup(c, communityId, input) {
  if (!input) return DEFAULT_GROUP;
  const m = await c.meta();
  const groups = m.communities.find((x) => x.id === communityId)?.groups || [];
  const hit = groups.find((g) => g.toLowerCase() === input.toLowerCase()) || groups.find((g) => g.toLowerCase().includes(input.toLowerCase()));
  if (!hit) throw new Error(`unknown calendar group "${input}"; known: ${groups.join(', ')}`);
  return hit;
}

const server = new McpServer({ name: 'altea', version: '0.1.0' });

const dateDesc = 'YYYY-MM-DD | today | tomorrow | mon..sun (next such day) | +N days. Toronto time.';
const scheduleShape = {
  date: z.string().optional().describe(dateDesc),
  days: z.number().int().min(1).max(45).optional().describe('How many consecutive days from `date` (default 1). Fetched in parallel.'),
  group: z.string().optional().describe('Calendar group, e.g. "Boutique Fitness" (default), "Pickleball", "Aquatics", "Recovery & Wellness", "Personalized Performance", "Active Kids Club". Substring ok.'),
  community: z.string().optional().describe('Club name or com_ id. Default Altea Ottawa.'),
  instructor: z.string().optional().describe('Instructor name substring, e.g. "Timo".'),
  type: z.string().optional().describe('Event type tag substring: Cycle, HIIT, Barre, Boxing, Hot Yoga, Hyrox, LF3, LF3 Strength, LF3 Tread, Mobility, Pilates, Reformer Pilates, Strength, Yoga.'),
  studio: z.string().optional().describe('Studio/calendar substring, e.g. "Cycle Studio", "Reformer".'),
  query: z.string().optional().describe('Free-text match over title, studio, instructors, types.'),
  availableOnly: z.boolean().optional().describe('Only events with spots left.'),
  mine: z.boolean().optional().describe('Only events I am booked into or waitlisted for.'),
  after: z.string().optional().describe('Earliest start time HH:MM (24h).'),
  before: z.string().optional().describe('Latest start time HH:MM (24h).'),
  timeOfDay: z.enum(['morning', 'lateMorning', 'afternoon', 'lateAfternoon', 'evening', 'night']).optional().describe('App bands: morning 0-9, lateMorning 9-12, afternoon 12-15, lateAfternoon 15-18, evening 18-21, night 21-24.'),
  withDescription: z.boolean().optional().describe('Include class descriptions (bigger output).'),
};

server.tool('altea_status', 'Session health for myaltea.app: signed in?, cookies, discovered server-action ids. Call first if another altea tool returns NOT_SIGNED_IN.', {}, run((c) => c.status()));

server.tool('altea_schedule', 'Altea class schedule for one or more days with spots left, instructors, studio, my booking status. Each event has an id (evt_…) used by altea_event / altea_book. Reads only.', scheduleShape,
  run(async (c, a) => { const communityId = await resolveCommunity(c, a.community); const group = await resolveGroup(c, communityId, a.group); return c.schedule({ ...a, communityId, group }); }));

server.tool('altea_find', 'Search upcoming Altea classes across a date range (default next 7 days) by words in title / instructor / type / studio. Returns flat event list. Reads only.', {
  query: z.string().describe('Words to match, e.g. "main stage ride", "reformer level 1", "timo".'),
  from: z.string().optional().describe(dateDesc), days: z.number().int().min(1).max(45).optional(),
  group: scheduleShape.group, community: scheduleShape.community, availableOnly: scheduleShape.availableOnly, instructor: scheduleShape.instructor, type: scheduleShape.type, after: scheduleShape.after, before: scheduleShape.before,
}, run(async (c, a) => { const communityId = await resolveCommunity(c, a.community); const group = await resolveGroup(c, communityId, a.group); return c.find({ ...a, communityId, group }); }));

server.tool('altea_event', 'Details for one event: description, spots, instructors, my booking (bookingId + cancellation deadline/fee), booking options (perk, when booking opens), conflicts, unsigned waivers, waitlist size. Reads only.', { eventId: z.string().describe('evt_… id from altea_schedule') }, run((c, a) => c.event(a.eventId)));

server.tool('altea_bookings', 'My upcoming (or past) Altea bookings with bookingId, status, canCancel, and whether cancelling now would be a late cancel with a fee. Reads only.', {
  from: z.string().optional().describe(dateDesc + ' Default today.'), to: z.string().optional().describe('End date (inclusive).'), days: z.number().int().min(1).max(120).optional().describe('Range length when `to` is absent (default 30).'),
}, run((c, a) => c.bookings(a)));

server.tool('altea_book', 'BOOK a spot in an event for the signed-in member (real reservation; a late cancellation later costs a fee). Uses the default unlimited membership and the default card on file, exactly like the app. Refuses if booking window not open, a waiver is unsigned, or there is a schedule conflict, unless force=true. Confirm intent with the user first unless they explicitly asked to book.', {
  eventId: z.string(), force: z.boolean().optional().describe('Override window/conflict/full checks.'), perkId: z.string().optional().describe('prk_… to pick a specific membership option'), paymentMethodId: z.string().optional().describe('pm_… to pick a specific card'),
}, run((c, a) => c.book(a)));

server.tool('altea_cancel', 'CANCEL one of my bookings by bookingId (bkg_…) or eventId (evt_…). Refuses a late cancellation (inside the policy window, fee applies) unless force=true. Confirm intent with the user first unless they explicitly asked to cancel.', {
  bookingId: z.string().optional(), eventId: z.string().optional(), force: z.boolean().optional(),
}, run((c, a) => c.cancel(a)));

server.tool('altea_waitlist', 'Join or leave the waitlist of a full event.', { eventId: z.string(), action: z.enum(['join', 'leave']) }, run((c, a) => c.waitlist(a)));

server.tool('altea_meta', 'Reference data: clubs (communities) with their calendar groups, event-type tags, instructor list. Cached 7 days; refresh=true to refetch.', { refresh: z.boolean().optional() }, run((c, a) => c.meta(a)));

server.tool('altea_actions', 'Discover/refresh the current build\'s server-action ids (book/cancel/waitlist). Run with refresh=true if book/cancel start failing after an app deploy.', { refresh: z.boolean().optional() }, run((c, a) => c.ensureActions({ force: !!a.refresh })));

const transport = new StdioServerTransport();
await server.connect(transport);
log('ready');
process.on('SIGTERM', async () => { await client?.close().catch(() => {}); process.exit(0); });
process.on('SIGINT', async () => { await client?.close().catch(() => {}); process.exit(0); });
