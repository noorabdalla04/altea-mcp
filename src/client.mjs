// AlteaClient: the typed API surface over myaltea.app.
//
// Reads  = GET <page>?params with `RSC: 1`  → parse rows → slim JSON.
// Writes = Next.js server actions (ids discovered per build, see discover.mjs).
//   cancel / waitlist-leave → POST "/" from Node (unguarded route, fast).
//   book / waitlist-join    → POST "/booking/<eventId>" inside a real Chrome page
//                             (route is guarded by the bot challenge).

import { readFile, writeFile } from 'node:fs/promises';
import { HttpSession, NotSignedIn, ORIGIN, ACTIONS_FILE, META_FILE, TZ, openBrowser, exportCookies, inPageAction } from './session.mjs';
import { parseRSC, eventsFromRows, findRow, deepFindInRows, parseActionResponse } from './rsc.mjs';
import { discoverActions } from './discover.mjs';

export const DEFAULT_COMMUNITY_ID = 'com_6ETcyzRKh3aCzpjKKhdT'; // Altea Ottawa
export const DEFAULT_GROUP = 'Boutique Fitness';

// ---------- dates (all "local" means America/Toronto) ----------

const fmtParts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'shortOffset' });

export function localParts(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(fmtParts.formatToParts(d).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  const off = (p.timeZoneName || 'GMT-4').replace('GMT', '');
  const offNorm = /^[+-]\d{1,2}(:\d{2})?$/.test(off) ? (off.includes(':') ? off : off.replace(/^([+-])(\d{1,2})$/, (m, s, h) => `${s}${h.padStart(2, '0')}:00`)) : '-04:00';
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}`, iso: `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}${offNorm}`, epoch: d.getTime() };
}

export function todayLocal() { return localParts(new Date()).date; }
export function addDays(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d + n)); return dt.toISOString().slice(0, 10); }
export function toDDMMYYYY(ymd) { const [y, m, d] = ymd.split('-'); return `${d}-${m}-${y}`; }
export function weekdayOf(ymd) { const [y, m, d] = ymd.split('-').map(Number); return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; }

/** Accepts YYYY-MM-DD, "today", "tomorrow", weekday names ("sat" = next Saturday incl. today), or +N. */
export function resolveDate(input) {
  const today = todayLocal();
  if (!input || input === 'today') return today;
  if (input === 'tomorrow') return addDays(today, 1);
  if (/^\+\d+$/.test(input)) return addDays(today, Number(input.slice(1)));
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  if (/^\d{2}-\d{2}-\d{4}$/.test(input)) { const [d, m, y] = input.split('-'); return `${y}-${m}-${d}`; }
  const wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(input.slice(0, 3).toLowerCase());
  if (wd >= 0) { for (let i = 0; i < 7; i++) { const c = addDays(today, i); if (weekdayOf(c).toLowerCase() === input.slice(0, 3).toLowerCase()) return c; } }
  const t = Date.parse(input);
  if (!Number.isNaN(t)) return localParts(t).date;
  throw new Error(`Unrecognised date: ${input}`);
}

const stripHtml = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// ---------- shaping ----------

export function slimEvent(e, { withDescription = false } = {}) {
  const start = localParts(e.startDate);
  const durationMin = e.duration ?? null;
  const end = start && durationMin != null ? localParts(start.epoch + durationMin * 60_000) : null;
  const instructors = Object.entries(e.resources || {}).map(([k, r]) => ({ id: r.id || k, name: r.name || r.label }));
  const out = {
    id: e.id,
    title: (e.title || '').trim(),
    date: start?.date ?? null,
    weekday: start ? weekdayOf(start.date) : null,
    time: start?.time ?? null,
    end: end?.time ?? null,
    start: start?.iso ?? e.startDate,
    duration: durationMin,
    studio: e.calendar ?? null,
    community: e.communityName ?? null,
    communityId: e.communityId ?? null,
    instructors: instructors.map((i) => i.name),
    instructorIds: instructors.map((i) => i.id),
    types: Object.values(e.tags || {}).map((t) => t.label),
    spotsLeft: e.spotsLeft ?? null,
    full: (e.spotsLeft ?? 1) <= 0,
    myStatus: e.userBookingStatus ?? null,
    waitlisted: !!e.waitlisted,
    checkInWindow: e.checkInWindow ?? null,
    status: e.status ?? null,
    url: `${ORIGIN}/booking/${e.id}`,
  };
  if (withDescription) out.description = stripHtml(e.description);
  return out;
}

const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function matchesFilters(ev, f = {}) {
  if (f.availableOnly && ev.full) return false;
  if (f.mine && !ev.myStatus && !ev.waitlisted) return false;
  if (f.instructor && !ev.instructors.some((n) => norm(n).includes(norm(f.instructor)))) return false;
  if (f.type && !ev.types.some((t) => norm(t).includes(norm(f.type)))) return false;
  if (f.studio && !norm(ev.studio).includes(norm(f.studio))) return false;
  if (f.query) {
    const hay = norm([ev.title, ev.studio, ...ev.instructors, ...ev.types].join(' '));
    const terms = norm(f.query).split(' ').filter(Boolean);
    if (!terms.every((t) => hay.includes(t))) return false;
  }
  if (f.after && ev.time < f.after) return false;
  if (f.before && ev.time > f.before) return false;
  if (f.timeOfDay) {
    const h = Number(ev.time.slice(0, 2));
    const band = { morning: [0, 9], lateMorning: [9, 12], afternoon: [12, 15], lateAfternoon: [15, 18], evening: [18, 21], night: [21, 24] }[f.timeOfDay];
    if (band && !(h >= band[0] && h < band[1])) return false;
  }
  return true;
}

function extractArrayAfter(raw, key) {
  const idx = raw.indexOf(`"${key}":[`);
  if (idx < 0) return null;
  let i = idx + key.length + 3, depth = 0, inStr = false, esc = false;
  const start = i;
  for (; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

// ---------- the client ----------

export class Altea {
  // Headed by default: the booking backend rejects headless Chrome ("unable to process your booking"),
  // verified 2026-09-19. Set ALTEA_HEADLESS=1 to try headless again.
  constructor({ log = () => {}, headless = process.env.ALTEA_HEADLESS === '1' } = {}) {
    this.log = log; this.headless = headless;
    this.http = null; this.browser = null; this.page = null; this.actions = null; this._meta = null;
  }

  async init() { if (!this.http) this.http = await HttpSession.load(); return this; }

  async close() {
    if (this.browser) { try { await exportCookies(this.browser.context); } catch { /* ignore */ } await this.browser.close().catch(() => {}); this.browser = null; this.page = null; }
    if (this.http) await this.http.persist();
  }

  // ----- reads -----

  schedulePath(ymd, group = DEFAULT_GROUP, communityId = DEFAULT_COMMUNITY_ID) {
    const q = new URLSearchParams({ date: toDDMMYYYY(ymd), calendarGroup: group, communityId });
    return `/booking?${q.toString()}`;
  }

  /** One day, raw + parsed. */
  async day(ymd, { group = DEFAULT_GROUP, communityId = DEFAULT_COMMUNITY_ID, withDescription = false } = {}) {
    const t0 = Date.now();
    const text = await this.http.rsc(this.schedulePath(ymd, group, communityId));
    const rows = parseRSC(text);
    const events = eventsFromRows(rows).map((e) => slimEvent(e, { withDescription }));
    events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    { const m = this.#metaFromRows(rows); const prev = this._meta || {}; this._meta = { types: m.types.length ? m.types : (prev.types || []), instructors: m.instructors.length ? m.instructors : (prev.instructors || []), communities: m.communities.length ? m.communities : (prev.communities || []) }; }
    this.log(`schedule ${ymd} ${group}: ${events.length} events, ${text.length}B, ${Date.now() - t0}ms`);
    return { date: ymd, weekday: weekdayOf(ymd), group, communityId, events };
  }

  /** Range of days, fetched in parallel. */
  async schedule({ date = 'today', days = 1, group = DEFAULT_GROUP, communityId = DEFAULT_COMMUNITY_ID, withDescription = false, concurrency = 6, ...filters } = {}) {
    const start = resolveDate(date);
    const dates = Array.from({ length: Math.max(1, Math.min(days, 45)) }, (_, i) => addDays(start, i));
    const results = new Array(dates.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, dates.length) }, async () => {
      while (next < dates.length) { const i = next++; results[i] = await this.day(dates[i], { group, communityId, withDescription }); }
    }));
    const hasFilter = Object.keys(filters).some((k) => filters[k] !== undefined && filters[k] !== false && filters[k] !== null && filters[k] !== '');
    for (const d of results) if (hasFilter) d.events = d.events.filter((e) => matchesFilters(e, filters));
    return { from: dates[0], to: dates[dates.length - 1], group, communityId, days: results, count: results.reduce((n, d) => n + d.events.length, 0) };
  }

  #metaFromRows(rows) {
    const isList = (j, prefix) => Array.isArray(j) && j.length > 0 && j[0] && typeof j[0].id === 'string' && j[0].id.startsWith(prefix) && 'label' in j[0];
    const types = deepFindInRows(rows, (j) => isList(j, 'evttag_'));
    const instructors = deepFindInRows(rows, (j) => isList(j, 'res_'));
    const communities = deepFindInRows(rows, (j) => Array.isArray(j) && j.length > 0 && j[0] && typeof j[0].communityId === 'string' && Array.isArray(j[0].calendarGroups));
    return {
      types: types ? types.map((t) => ({ id: t.id, label: t.label })) : [],
      instructors: instructors ? instructors.map((r) => ({ id: r.id, name: r.label })) : [],
      communities: communities ? communities.map((c) => ({ id: c.communityId, name: c.communityName, timezone: c.timezone, groups: c.calendarGroups })) : [],
    };
  }

  /** Event types, instructors, communities + their calendar groups (cached on disk). */
  async meta({ refresh = false } = {}) {
    if (!refresh) {
      if (this._meta?.communities?.length && this._meta?.types?.length) return this._meta;
      try { const m = JSON.parse(await readFile(META_FILE, 'utf8')); if (m.communities?.length && m.types?.length && m.instructors?.length && Date.now() - Date.parse(m.savedAt) < 7 * 86_400_000) { this._meta = m; return m; } } catch { /* none */ }
    }
    for (let i = 0; i < 4; i++) { await this.day(addDays(todayLocal(), i)); if (this._meta?.types?.length && this._meta?.instructors?.length) break; }
    const m = { ...this._meta, savedAt: new Date().toISOString() };
    await writeFile(META_FILE, JSON.stringify(m, null, 2)).catch(() => {});
    this._meta = m;
    return m;
  }

  /** Event detail + my booking context (perks, policy, payment methods, agreements). */
  async event(eventId) {
    if (!/^evt_[A-Za-z0-9_]+$/.test(eventId)) throw new Error(`bad eventId: ${eventId}`);
    const text = await this.http.rsc(`/booking/${eventId}`);
    const rows = parseRSC(text);
    const ev = deepFindInRows(rows, (j) => j && typeof j === 'object' && !Array.isArray(j) && j.id === eventId && 'startDate' in j);
    const ctx = deepFindInRows(rows, (j) => j && typeof j === 'object' && !Array.isArray(j) && 'activeBookings' in j && 'context' in j);
    if (!ev && !ctx) throw new Error(`event ${eventId}: not found in payload (wrong id, or event removed)`);
    return this.#shapeEvent(ev ?? null, ctx ?? null, eventId);
  }

  #shapeEvent(ev, ctx, eventId) {
    const out = { id: eventId, event: ev ? slimEvent(ev, { withDescription: true }) : null };
    if (!ctx) return out;
    const me = ctx.context?.currentUser || {};
    const pair = (ctx.activeBookings || []).find((p) => p?.[1]?.id?.startsWith?.('bkg_'));
    const booking = pair ? pair[1] : null;
    const startMs = ev ? Date.parse(ev.startDate) : null;
    out.myBooking = booking ? {
      bookingId: booking.id,
      status: booking.status,
      perk: booking.perk?.title,
      cancellation: shapePolicy(booking.perk?.cancellation, startMs),
    } : null;
    out.options = (me.perks || []).map((p) => ({
      perkId: p.perkId, userPerkId: p.userPerkId, title: p.title, price: p.price, unlimited: !!p.unlimited, disabled: !!p.disabled,
      bookingWindowMin: p.bookingWindow ?? null,
      bookableFrom: startMs && p.bookingWindow ? localParts(startMs - p.bookingWindow * 60_000).iso : null,
      dailyMaxUsages: p.dailyMaxUsages ?? null, dailyUsages: p.dailyUsages ?? 0,
      cancellation: shapePolicy(p.cancellation, startMs),
    }));
    out.defaultOption = (ctx.possibleBookings || [])[0]?.defaultSelectedPerk ?? null;
    out.paymentMethods = (me.paymentMethods || []).map((p) => ({ id: p.id, label: p.label, brand: p.model, default: !!p.default, expired: !!p.expired }));
    out.unsignedAgreements = (me.unsignedAgreements || []).map((a) => (typeof a === 'string' ? a : a.title || a.id));
    out.conflicts = (me.eventConflicts || []).map((c) => (typeof c === 'string' ? c : { id: c.id, title: c.title, startDate: c.startDate }));
    out.alerts = me.alerts || [];
    out.waitlistPosition = me.waitlist ?? 0;
    out.waitlistedUsers = (ctx.waitlistedUsers || []).length;
    out.userId = me.id ?? null;
    return out;
  }

  /** My bookings: per-day counts from the Bookings page, then each day's details in parallel. */
  async bookings({ from = 'today', to, days = 30 } = {}) {
    const start = resolveDate(from);
    const end = to ? resolveDate(to) : addDays(start, days);
    const text = await this.http.rsc(`/?date=${start}`);
    const rows = parseRSC(text);
    const counts = deepFindInRows(rows, (j) => Array.isArray(j) && j.length > 0 && Array.isArray(j[0]) && /^\d{4}-\d{2}-\d{2}$/.test(j[0][0]) && j[0][1] && typeof j[0][1] === 'object' && 'bookings' in j[0][1]);
    const dates = counts ? counts.map(([d]) => d).filter((d) => d >= start && d <= end).sort() : [];
    const details = await Promise.all(dates.map(async (d) => {
      const t = d === start ? text : await this.http.rsc(`/?date=${d}`);
      return this.#bookingsFromRows(parseRSC(t), d);
    }));
    const items = details.flat().sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    return { from: start, to: end, datesWithBookings: dates, count: items.length, bookings: items };
  }

  #bookingsFromRows(rows, ymd) {
    const list = deepFindInRows(rows, (j) => Array.isArray(j) && j.length > 0 && j[0] && typeof j[0] === 'object' && 'canCancel' in j[0] && 'event' in j[0]);
    if (!list) return [];
    return list.map((b) => {
      const ev = b.event ? slimEvent(b.event) : null;
      const startMs = ev ? Date.parse(b.event.startDate) : (b.date ? Date.parse(b.date) : null);
      const pk = b.perk || b.booking?.perk || {};
      const policySrc = pk.cancellation && typeof pk.cancellation === 'object'
        ? pk.cancellation
        : { enabled: pk.cancellation ?? pk.enabled ?? (pk.cancellationWindow != null), cancellationWindow: pk.cancellationWindow, cancellationPrice: pk.cancellationPrice, refund: pk.refund };
      const bookingId = typeof b.id === 'string' && b.id.startsWith('bkg_') ? b.id : (b.booking?.id || b.bookingId || null);
      return {
        bookingId,
        eventId: ev?.id ?? b.eventId ?? null,
        date: ev?.date ?? ymd,
        title: ev?.title ?? b.title ?? null,
        time: ev?.time ?? (b.date ? localParts(b.date)?.time : null),
        start: ev?.start ?? b.date ?? null,
        studio: ev?.studio ?? null,
        instructors: ev?.instructors ?? [],
        status: b.status ?? b.booking?.status ?? null,
        waitlisted: !!(b.isWaitlist || b.waitlisted || b.waitlist),
        forMe: b.isCurrentUser !== false,
        canCancel: !!b.canCancel,
        membership: pk.title ?? null,
        cancellation: shapePolicy(policySrc, startMs),
        url: ev ? ev.url : null,
      };
    });
  }

  /** Search across a range. */
  async find({ query, from = 'today', days = 7, group, communityId, ...filters } = {}) {
    const res = await this.schedule({ date: from, days, group, communityId, query, ...filters });
    return { ...res, events: res.days.flatMap((d) => d.events) };
  }

  // ----- action plumbing -----

  async ensureActions({ force = false, eventId } = {}) {
    if (this.actions && !force) return this.actions;
    const pages = ['/', '/booking'];
    if (eventId) pages.push(`/booking/${eventId}`);
    else {
      for (let i = 0; i < 8; i++) {
        try { const d = await this.day(addDays(todayLocal(), i)); if (d.events[0]) { pages.push(`/booking/${d.events[0].id}`); break; } } catch { /* ignore */ }
      }
    }
    const disc = await discoverActions((u) => this.http.html(u), { pages, cacheFile: ACTIONS_FILE, force, log: this.log });
    this.actions = disc.actions;
    return this.actions;
  }

  async #page() {
    if (!this.page) {
      this.browser = await openBrowser({ headless: this.headless, log: this.log });
      this.page = this.browser.context.pages()[0] || (await this.browser.context.newPage());
    }
    return this.page;
  }

  /** Fast path first (POST "/"), then the in-page path if the route rejects or the action is unknown there. */
  async #runAction(name, args, { eventId, preferPage = false } = {}) {
    const actions = await this.ensureActions({ eventId });
    const id = actions[name];
    if (!id) throw new Error(`server action ${name} not found in current build (try: altea actions --refresh)`);
    const t0 = Date.now();
    if (!preferPage) {
      const r = await this.http.action('/', id, args);
      const parsed = parseActionResponse(r.text);
      const unknown = /Failed to find Server Action|Server Action .* was not found/i.test(r.text);
      if (r.status === 200 && !unknown) { this.log(`${name}: fast path ${Date.now() - t0}ms`); return { via: 'http', status: r.status, revalidated: r.revalidated, result: parsed.result, serverError: parsed.serverError }; }
      this.log(`${name}: fast path unavailable (${r.status}${unknown ? ', unknown on /' : ''}), using page`);
    }
    const page = await this.#page();
    const r = await inPageAction(page, eventId ? `/booking/${eventId}` : '/booking', id, args);
    try { await exportCookies(this.browser.context); } catch { /* ignore */ }
    if (!this.headless) { await this.browser.close().catch(() => {}); this.browser = null; this.page = null; } // don't leave a window up
    const parsed = parseActionResponse(r.text);
    this.log(`${name}: page path ${Date.now() - t0}ms`);
    return { via: 'page', status: r.status, revalidated: r.revalidated, result: parsed.result, serverError: parsed.serverError, raw: r.status !== 200 ? r.text.slice(0, 500) : undefined };
  }

  // ----- actions -----

  /**
   * Book an event. Builds the exact payload the web app sends. Refuses (without
   * force) when a waiver is unsigned or a schedule conflict exists.
   */
  async book({ eventId, perkId, paymentMethodId, force = false }) {
    const info = await this.event(eventId);
    if (!info.event) throw new Error('event not found');
    if (info.myBooking) return { ok: true, alreadyBooked: true, booking: info.myBooking, event: info.event };
    if (info.unsignedAgreements.length && !force) throw new Error(`Unsigned agreement(s) required in the app first: ${info.unsignedAgreements.join(', ')}`);
    if (info.conflicts.length && !force) throw new Error(`Schedule conflict: ${JSON.stringify(info.conflicts)} (pass force to book anyway)`);
    const opts = info.options.filter((o) => !o.disabled);
    let opt = perkId ? opts.find((o) => o.perkId === perkId) : null;
    if (!opt && info.defaultOption) { const m = info.defaultOption.match(/__own__([^|]+)\|([^|]+)\|/); if (m) opt = opts.find((o) => o.perkId === m[1] && o.userPerkId === m[2]); }
    if (!opt) opt = opts.find((o) => o.unlimited) || opts[0];
    if (!opt) throw new Error('No usable membership/perk for this event on your account.');
    if (opt.bookableFrom && Date.parse(opt.bookableFrom) > Date.now() && !force) throw new Error(`Booking window not open yet: opens ${opt.bookableFrom} (window ${opt.bookingWindowMin} min before start)`);
    const pm = paymentMethodId ? info.paymentMethods.find((p) => p.id === paymentMethodId) : (info.paymentMethods.find((p) => p.default && !p.expired) || info.paymentMethods.find((p) => !p.expired));
    if (!pm) throw new Error('No payment method on file (the app requires one for the late-cancellation fee).');
    if (info.event.full && !force) throw new Error(`Event is full (0 spots). Use waitlist join instead.`);
    const args = [{
      eventId,
      bookings: [{
        agreements: [],
        equipment: '$undefined',
        paymentMethodId: pm.id,
        perkId: opt.perkId,
        perkUserId: info.userId,
        price: opt.price ?? 0,
        userPerkId: opt.userPerkId,
        userId: info.userId,
      }],
    }];
    this.log(`book payload ${JSON.stringify(args)}`);
    const r = await this.#runAction('confirmBookingAction', args, { eventId, preferPage: true });
    const after = await this.event(eventId).catch(() => null);
    const ok = !!after?.myBooking;
    return { ok, via: r.via, status: r.status, serverError: r.serverError, result: ok ? undefined : r.result, booking: after?.myBooking ?? null, event: after?.event ?? info.event, option: opt.title, paymentMethod: pm.label };
  }

  /** Cancel by bookingId or eventId. Refuses late cancellations (fee) unless force. */
  async cancel({ bookingId, eventId, force = false }) {
    let info = null;
    if (!bookingId) {
      if (!eventId) throw new Error('need bookingId or eventId');
      info = await this.event(eventId);
      if (!info.myBooking) return { ok: true, alreadyCancelled: true, event: info.event };
      bookingId = info.myBooking.bookingId;
    }
    const policy = info?.myBooking?.cancellation;
    if (policy?.late && !force) throw new Error(`Late cancellation: inside the ${policy.windowHours}h window, fee ${policy.feeText}. Pass force to cancel anyway.`);
    const r = await this.#runAction('cancelBookingAction', [{ bookingId }], { eventId });
    const after = eventId ? await this.event(eventId).catch(() => null) : null;
    const ok = r.status === 200 && !r.serverError && (!after || !after.myBooking);
    return { ok, via: r.via, status: r.status, serverError: r.serverError, result: ok ? undefined : r.result, bookingId, event: after?.event ?? info?.event ?? null };
  }

  async waitlist({ eventId, action }) {
    if (action === 'join') {
      const r = await this.#runAction('joinWaitlistAction', [{ eventId }], { eventId, preferPage: true });
      const after = await this.event(eventId).catch(() => null);
      return { ok: r.status === 200 && !r.serverError, via: r.via, serverError: r.serverError, waitlistPosition: after?.waitlistPosition ?? null, event: after?.event ?? null };
    }
    if (action === 'leave') {
      const r = await this.#runAction('leaveWaitlistAction', [{ eventId }], { eventId });
      const after = await this.event(eventId).catch(() => null);
      return { ok: r.status === 200 && !r.serverError, via: r.via, serverError: r.serverError, waitlistPosition: after?.waitlistPosition ?? null, event: after?.event ?? null };
    }
    throw new Error('action must be join|leave');
  }

  async status() {
    const cookies = this.http?.cookies || [];
    let signedIn = false, userId = null, err = null;
    try { const t = await this.http.rsc('/booking'); signedIn = true; const m = t.match(/"currentUser":\{[^}]*?"id":"([^"]+)"/); userId = m ? m[1] : null; } catch (e) { err = e.message; }
    let actionsInfo = null;
    try { const a = JSON.parse(await readFile(ACTIONS_FILE, 'utf8')); actionsInfo = { key: a.key, discoveredAt: a.discoveredAt, names: Object.keys(a.actions) }; } catch { /* none */ }
    return { signedIn, userId, error: err, cookies: cookies.length, actions: actionsInfo, headless: this.headless };
  }
}

function shapePolicy(c, startMs) {
  if (!c) return null;
  const windowMin = c.cancellationWindow ?? null;
  const feeCents = c.cancellationPrice ?? null;
  const deadline = startMs && windowMin != null ? startMs - windowMin * 60_000 : null;
  return {
    enabled: !!c.enabled,
    windowHours: windowMin != null ? windowMin / 60 : null,
    feeCents,
    feeText: feeCents != null ? `$${(feeCents / 100).toFixed(2)}${feeCents ? ' + tax' : ''}` : null,
    deadline: deadline ? localParts(deadline).iso : null,
    late: deadline ? Date.now() > deadline : null,
    text: c.shortText ?? null,
  };
}
