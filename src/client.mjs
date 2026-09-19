// AlteaClient: the typed API surface over myaltea.app.
//
// Reads  = GET <page>?params with `RSC: 1`  → parse rows → slim JSON.
// Writes = Next.js server actions (ids discovered per build, see discover.mjs).
//   cancel / waitlist-leave → POST "/" from Node (unguarded route, fast).
//   book / waitlist-join    → POST "/booking/<eventId>" inside a real, headed Chrome page
//                             (route is bot-guarded; headless is refused server-side).

import { readFile, writeFile } from 'node:fs/promises';
import { HttpSession, ORIGIN, ACTIONS_FILE, META_FILE, TZ, openBrowser, exportCookies, inPageAction } from './session.mjs';
import { parseRSC, eventsFromRows, deepFindInRows, parseActionResponse } from './rsc.mjs';
import { discoverActions } from './discover.mjs';

export const DEFAULT_COMMUNITY_ID = 'com_6ETcyzRKh3aCzpjKKhdT'; // Altea Ottawa
export const DEFAULT_GROUP = 'Boutique Fitness';
export const ALL_GROUPS = 'all';

/**
 * Membership rules (Altea Ottawa, Gold). Values reported by the app win when present;
 * these are the documented fallbacks and what the tool descriptions promise.
 */
export const RULES = {
  cancelWindowMin: 8 * 60,    // cancel ≥ 8 h before start, otherwise the late-cancellation fee applies
  bookingWindowMin: 48 * 60,  // booking opens 48 h before start (the app reports 2940 min = 49 h for Gold perks)
};

// ---------- dates & times (all "local" = America/Toronto) ----------

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
export function addDays(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
export function toDDMMYYYY(ymd) { const [y, m, d] = ymd.split('-'); return `${d}-${m}-${y}`; }
export function weekdayOf(ymd) { const [y, m, d] = ymd.split('-').map(Number); return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; }

/** YYYY-MM-DD | DD-MM-YYYY | today | tomorrow | mon..sun (next such day, today included) | +N | any Date.parse-able string. */
export function resolveDate(input, today = todayLocal()) {
  if (input == null || input === '' || input === 'today') return today;
  const s = String(input).trim().toLowerCase();
  if (s === 'tomorrow' || s === 'tmrw') return addDays(today, 1);
  if (s === 'yesterday') return addDays(today, -1);
  if (/^\+\d+$/.test(s)) return addDays(today, Number(s.slice(1)));
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) { const [d, m, y] = s.split('-'); return `${y}-${m}-${d}`; }
  const wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(s.replace(/^next\s+/, '').slice(0, 3));
  if (wd >= 0) { const skipToday = s.startsWith('next '); for (let i = skipToday ? 1 : 0; i < 8; i++) { const c = addDays(today, i); if (weekdayOf(c).toLowerCase() === s.replace(/^next\s+/, '').slice(0, 3)) return c; } }
  const t = Date.parse(input);
  if (!Number.isNaN(t)) return localParts(t).date;
  throw new Error(`Unrecognised date: ${input}`);
}

/** '15:00' | '3pm' | '3 pm' | '3:30pm' | '15h' | '1500' → 'HH:MM' (24 h). */
export function parseTime(input) {
  if (input == null || input === '') return null;
  const s = String(input).trim().toLowerCase().replace(/\s+/g, '');
  let m = s.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm|h)?$/);
  if (!m) throw new Error(`Unrecognised time: ${input}`);
  let h = Number(m[1]); const min = Number(m[2] || 0); const ap = m[3];
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) throw new Error(`Unrecognised time: ${input}`);
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

const stripHtml = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
export const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- shaping ----------

export function slimEvent(e, { withDescription = false } = {}) {
  const start = localParts(e.startDate);
  const durationMin = e.duration ?? null;
  const end = start && durationMin != null ? localParts(start.epoch + durationMin * 60_000) : null;
  const instructors = Object.entries(e.resources || {}).map(([k, r]) => ({ id: r.id || k, name: r.name || r.label })).filter((i) => i.name);
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

/** Normalise user-facing filters (times in any format → HH:MM). */
export function normaliseFilters(f = {}) {
  const out = { ...f };
  for (const k of ['after', 'before', 'at']) if (out[k]) out[k] = parseTime(out[k]);
  if (out.near != null && out.near !== '') out.near = Number(out.near);
  return out;
}

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
  if (f.at) {
    const startM = toMin(ev.time); const endM = ev.end ? toMin(ev.end) : startM + 60; const atM = toMin(f.at);
    if (f.near != null && !Number.isNaN(f.near)) { if (Math.abs(startM - atM) > f.near) return false; }
    else if (!(startM <= atM && atM < Math.max(endM, startM + 1))) return false;
  }
  if (f.timeOfDay) {
    const h = Number(ev.time.slice(0, 2));
    const band = { morning: [0, 9], lateMorning: [9, 12], afternoon: [12, 15], lateAfternoon: [15, 18], evening: [18, 21], night: [21, 24] }[f.timeOfDay];
    if (band && !(h >= band[0] && h < band[1])) return false;
  }
  return true;
}

export function shapePolicy(c, startMs, fallback = RULES) {
  if (!c && !fallback) return null;
  const src = c || {};
  const windowMin = src.cancellationWindow ?? fallback?.cancelWindowMin ?? null;
  const feeCents = src.cancellationPrice ?? null;
  const deadline = startMs && windowMin != null ? startMs - windowMin * 60_000 : null;
  return {
    enabled: c ? !!(c.enabled ?? true) : true,
    windowHours: windowMin != null ? windowMin / 60 : null,
    feeCents,
    feeText: feeCents != null ? `$${(feeCents / 100).toFixed(2)}${feeCents ? ' + tax' : ''}` : null,
    deadline: deadline ? localParts(deadline).iso : null,
    late: deadline ? Date.now() > deadline : null,
    text: src.shortText ?? (windowMin != null ? `${windowMin / 60} hours before the event` : null),
    source: c ? 'app' : 'rules',
  };
}

/** Rank candidate names against a query: exact/first-name/substring/fuzzy. */
export function rankNames(query, names) {
  const q = norm(query); const qFirst = q.split(' ')[0];
  const lev = (a, b) => { const m = a.length, n = b.length; const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 1; j <= n; j++) dp[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return dp[m][n]; };
  return [...new Set(names.filter(Boolean))].map((name) => {
    const n = norm(name); const first = n.split(' ')[0];
    let score = 99;
    if (n === q) score = 0; else if (first === qFirst) score = 1; else if (n.includes(q)) score = 2; else if (first.startsWith(qFirst)) score = 3; else score = 4 + lev(first, qFirst);
    return { name, score };
  }).filter((x) => x.score <= 6).sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).map((x) => x.name);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

// ---------- the client ----------

export class Altea {
  #cache = new Map();

  // Headed by default: the booking backend rejects headless Chrome ("unable to process your booking"),
  // verified 2026-09-19. Set ALTEA_HEADLESS=1 to try headless again.
  constructor({ log = () => {}, headless = process.env.ALTEA_HEADLESS === '1', cacheTtlMs = Number(process.env.ALTEA_CACHE_TTL_MS ?? 45_000) } = {}) {
    this.log = log; this.headless = headless; this.cacheTtlMs = cacheTtlMs;
    this.http = null; this.browser = null; this.page = null; this.actions = null; this._meta = null;
  }

  async init() { if (!this.http) this.http = await HttpSession.load(); return this; }

  async close() {
    if (this.browser) { try { await exportCookies(this.browser.context); } catch { /* ignore */ } await this.browser.close().catch(() => {}); this.browser = null; this.page = null; }
    if (this.http) await this.http.persist();
  }

  clearCache() { this.#cache.clear(); }

  async #rsc(path, { nocache = false } = {}) {
    const hit = this.#cache.get(path);
    if (!nocache && hit && Date.now() - hit.t < this.cacheTtlMs) return hit.text;
    const text = await this.http.rsc(path);
    this.#cache.set(path, { t: Date.now(), text });
    return text;
  }

  // ----- resolution helpers -----

  async resolveCommunity(input) {
    if (!input) return DEFAULT_COMMUNITY_ID;
    if (input.startsWith('com_')) return input;
    const m = await this.meta();
    const hit = m.communities.find((c) => c.name.toLowerCase().includes(input.toLowerCase()));
    if (!hit) throw new Error(`unknown community "${input}"; known: ${m.communities.map((c) => c.name).join(', ')}`);
    return hit.id;
  }

  async resolveGroup(communityId, input) {
    if (!input) return DEFAULT_GROUP;
    const m = await this.meta();
    const c = m.communities.find((x) => x.id === communityId);
    const groups = c?.groups || [];
    const hit = groups.find((g) => g.toLowerCase() === input.toLowerCase()) || groups.find((g) => g.toLowerCase().includes(input.toLowerCase())) || groups.find((g) => norm(g).split(' ').some((w) => w.startsWith(norm(input))));
    if (!hit) throw new Error(`unknown calendar group "${input}" for ${c?.name || communityId}; known: ${groups.join(', ')}, or "all"`);
    return hit;
  }

  /** undefined → [Boutique Fitness]; "all" → every group of the club; otherwise one resolved group. */
  async groupsFor(communityId, group) {
    if (!group) return [DEFAULT_GROUP];
    if (group === ALL_GROUPS || group === '*') {
      const m = await this.meta();
      const c = m.communities.find((x) => x.id === communityId);
      return c?.groups?.length ? c.groups : [DEFAULT_GROUP];
    }
    return [await this.resolveGroup(communityId, group)];
  }

  // ----- reads -----

  schedulePath(ymd, group = DEFAULT_GROUP, communityId = DEFAULT_COMMUNITY_ID) {
    const q = new URLSearchParams({ date: toDDMMYYYY(ymd), calendarGroup: group, communityId });
    return `/booking?${q.toString()}`;
  }

  /** One day, one calendar group. */
  async day(ymd, { group = DEFAULT_GROUP, communityId = DEFAULT_COMMUNITY_ID, withDescription = false, nocache = false } = {}) {
    const t0 = Date.now();
    const text = await this.#rsc(this.schedulePath(ymd, group, communityId), { nocache });
    const rows = parseRSC(text);
    const events = eventsFromRows(rows).map((e) => ({ ...slimEvent(e, { withDescription }), group }));
    events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    { const m = this.#metaFromRows(rows); const prev = this._meta || {}; this._meta = { types: m.types.length ? m.types : (prev.types || []), instructors: m.instructors.length ? m.instructors : (prev.instructors || []), communities: m.communities.length ? m.communities : (prev.communities || []) }; }
    this.log(`schedule ${ymd} ${group}: ${events.length} events, ${text.length}B, ${Date.now() - t0}ms`);
    return { date: ymd, weekday: weekdayOf(ymd), group, communityId, events };
  }

  /**
   * Range of days × one or all calendar groups, fetched in parallel, merged per day, filtered.
   * filters: instructor, type, studio, query, availableOnly, mine, after, before, at, near, timeOfDay
   */
  async schedule({ date = 'today', days = 1, group, community, communityId, withDescription = false, concurrency = 8, nocache = false, ...rawFilters } = {}) {
    const cid = communityId || await this.resolveCommunity(community);
    const groups = await this.groupsFor(cid, group);
    const filters = normaliseFilters(rawFilters);
    const start = resolveDate(date);
    const dates = Array.from({ length: Math.max(1, Math.min(Number(days) || 1, 45)) }, (_, i) => addDays(start, i));
    const jobs = dates.flatMap((d) => groups.map((g) => ({ d, g })));
    const results = await mapLimit(jobs, concurrency, ({ d, g }) => this.day(d, { group: g, communityId: cid, withDescription, nocache }).catch((e) => ({ date: d, group: g, events: [], error: e.message })));
    const byDate = new Map(dates.map((d) => [d, { date: d, weekday: weekdayOf(d), events: [], errors: [] }]));
    for (const r of results) {
      const slot = byDate.get(r.date);
      if (r.error) slot.errors.push(`${r.group}: ${r.error}`);
      for (const e of r.events) if (!slot.events.some((x) => x.id === e.id)) slot.events.push(e);
    }
    const hasFilter = Object.keys(filters).some((k) => filters[k] !== undefined && filters[k] !== false && filters[k] !== null && filters[k] !== '');
    const out = [];
    for (const slot of byDate.values()) {
      slot.events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
      if (hasFilter) slot.events = slot.events.filter((e) => matchesFilters(e, filters));
      if (!slot.errors.length) delete slot.errors;
      out.push(slot);
    }
    return { from: dates[0], to: dates[dates.length - 1], groups, communityId: cid, filters: hasFilter ? filters : undefined, days: out, count: out.reduce((n, d) => n + d.events.length, 0) };
  }

  /** Free-text search across all groups (default) for the next N days; flat list. */
  async find({ query, from = 'today', days = 7, group = ALL_GROUPS, ...rest } = {}) {
    const res = await this.schedule({ date: from, days, group, query, ...rest });
    return { ...res, events: res.days.flatMap((d) => d.events) };
  }

  /** Everything an instructor teaches in a range, across all groups (default), with name suggestions when nothing matches. */
  async instructor({ name, date = 'today', days = 1, group = ALL_GROUPS, ...rest } = {}) {
    if (!name) throw new Error('instructor name required');
    const res = await this.schedule({ date, days, group, ...rest });
    const all = res.days.flatMap((d) => d.events);
    const sessions = all.filter((e) => e.instructors.some((n) => norm(n).includes(norm(name))));
    const seen = [...new Set(all.flatMap((e) => e.instructors))];
    const metaNames = (this._meta?.instructors || []).map((i) => i.name);
    const suggestions = sessions.length ? [] : rankNames(name, [...seen, ...metaNames]).slice(0, 6);
    return { name, from: res.from, to: res.to, groups: res.groups, count: sessions.length, sessions, instructorsSeen: seen.length, suggestions };
  }

  /**
   * The next future occurrence of something ("hot yin", "main stage ride", instructor "sara", type "cycle"):
   * first match at all, first match with spots, waitlist size and booking-window info for the first.
   */
  async next({ query, instructor, type, studio, from = 'today', days = 14, group = ALL_GROUPS, community, communityId, chunk = 3 } = {}) {
    if (!query && !instructor && !type && !studio) throw new Error('next: give a query, instructor, type or studio');
    const start = resolveDate(from); const now = Date.now();
    let first = null, firstOpen = null, scannedThrough = start;
    for (let i = 0; i < days && !(first && firstOpen); i += chunk) {
      const n = Math.min(chunk, days - i);
      const res = await this.schedule({ date: addDays(start, i), days: n, group, community, communityId, query, instructor, type, studio });
      for (const d of res.days) for (const e of d.events) {
        if (Date.parse(e.start) <= now) continue;
        if (!first) first = e;
        if (!firstOpen && !e.full) firstOpen = e;
        if (first && firstOpen) break;
      }
      scannedThrough = addDays(start, i + n - 1);
    }
    let detail = null;
    if (first) {
      try {
        const d = await this.event(first.id);
        detail = { waitlistedUsers: d.waitlistedUsers, myBooking: d.myBooking, bookableFrom: d.options[0]?.bookableFrom ?? null, bookableNow: d.options[0]?.bookableNow ?? null, cancellation: d.options[0]?.cancellation ?? null };
      } catch { /* detail is optional */ }
    }
    return { query: query || instructor || type || studio, from: start, searchedThrough: scannedThrough, next: first, nextWithSpots: firstOpen, sameEvent: !!(first && firstOpen && first.id === firstOpen.id), detail };
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

  /** Event types, instructors, communities + their calendar groups (cached on disk for 7 days). */
  async meta({ refresh = false } = {}) {
    if (!refresh) {
      if (this._meta?.communities?.length && this._meta?.types?.length) return { ...this._meta, rules: RULES };
      try { const m = JSON.parse(await readFile(META_FILE, 'utf8')); if (m.communities?.length && m.types?.length && m.instructors?.length && Date.now() - Date.parse(m.savedAt) < 7 * 86_400_000) { this._meta = m; return { ...m, rules: RULES }; } } catch { /* none */ }
    }
    for (let i = 0; i < 4; i++) { await this.day(addDays(todayLocal(), i)); if (this._meta?.types?.length && this._meta?.instructors?.length) break; }
    const m = { ...this._meta, savedAt: new Date().toISOString() };
    await writeFile(META_FILE, JSON.stringify(m, null, 2)).catch(() => {});
    this._meta = m;
    return { ...m, rules: RULES };
  }

  /** Event detail + my booking context (perks, policy, payment methods, agreements). Never cached. */
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
    out.myBooking = booking ? { bookingId: booking.id, status: booking.status, perk: booking.perk?.title, cancellation: shapePolicy(booking.perk?.cancellation, startMs) } : null;
    out.options = (me.perks || []).map((p) => {
      const win = p.bookingWindow ?? RULES.bookingWindowMin;
      const bookableFrom = startMs ? localParts(startMs - win * 60_000).iso : null;
      return {
        perkId: p.perkId, userPerkId: p.userPerkId, title: p.title, price: p.price, unlimited: !!p.unlimited, disabled: !!p.disabled,
        bookingWindowMin: win, bookingWindowSource: p.bookingWindow != null ? 'app' : 'rules',
        bookableFrom, bookableNow: bookableFrom ? Date.parse(bookableFrom) <= Date.now() : null,
        dailyMaxUsages: p.dailyMaxUsages ?? null, dailyUsages: p.dailyUsages ?? 0,
        cancellation: shapePolicy(p.cancellation, startMs),
      };
    });
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

  /** My bookings: per-day counts from the Bookings page, then each day's details in parallel. Never cached. */
  async bookings({ from = 'today', to, days = 30 } = {}) {
    const start = resolveDate(from);
    const end = to ? resolveDate(to) : addDays(start, Number(days) || 30);
    const text = await this.http.rsc(`/?date=${start}`);
    const rows = parseRSC(text);
    const counts = deepFindInRows(rows, (j) => Array.isArray(j) && j.length > 0 && Array.isArray(j[0]) && /^\d{4}-\d{2}-\d{2}$/.test(j[0][0]) && j[0][1] && typeof j[0][1] === 'object' && 'bookings' in j[0][1]);
    const dates = counts ? counts.map(([d]) => d).filter((d) => d >= start && d <= end).sort() : [];
    const details = await Promise.all(dates.map(async (d) => this.#bookingsFromRows(parseRSC(d === start ? text : await this.http.rsc(`/?date=${d}`)), d)));
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
      if (r.status === 200 && !unknown) { this.log(`${name}: fast path ${Date.now() - t0}ms`); this.clearCache(); return { via: 'http', status: r.status, revalidated: r.revalidated, result: parsed.result, serverError: parsed.serverError }; }
      this.log(`${name}: fast path unavailable (${r.status}${unknown ? ', unknown on /' : ''}), using page`);
    }
    const page = await this.#page();
    const r = await inPageAction(page, eventId ? `/booking/${eventId}` : '/booking', id, args);
    try { await exportCookies(this.browser.context); } catch { /* ignore */ }
    if (!this.headless) { await this.browser.close().catch(() => {}); this.browser = null; this.page = null; } // don't leave a window up
    const parsed = parseActionResponse(r.text);
    this.log(`${name}: page path ${Date.now() - t0}ms`);
    this.clearCache();
    return { via: 'page', status: r.status, revalidated: r.revalidated, result: parsed.result, serverError: parsed.serverError, raw: r.status !== 200 ? r.text.slice(0, 500) : undefined };
  }

  // ----- actions -----

  /** Book an event. Builds the exact payload the web app sends. Guards: window, waiver, conflict, full (override with force). */
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
    if (opt.bookableFrom && Date.parse(opt.bookableFrom) > Date.now() && !force) throw new Error(`Booking window not open yet: opens ${opt.bookableFrom} (${opt.bookingWindowMin / 60} h before start; the 48 h rule). Event starts ${info.event.start}.`);
    const pm = paymentMethodId ? info.paymentMethods.find((p) => p.id === paymentMethodId) : (info.paymentMethods.find((p) => p.default && !p.expired) || info.paymentMethods.find((p) => !p.expired));
    if (!pm) throw new Error('No payment method on file (the app requires one for the late-cancellation fee).');
    if (info.event.full && !force) throw new Error('Event is full (0 spots). Use waitlist join instead.');
    const args = [{ eventId, bookings: [{ agreements: [], equipment: '$undefined', paymentMethodId: pm.id, perkId: opt.perkId, perkUserId: info.userId, price: opt.price ?? 0, userPerkId: opt.userPerkId, userId: info.userId }] }];
    this.log(`book payload ${JSON.stringify(args)}`);
    const r = await this.#runAction('confirmBookingAction', args, { eventId, preferPage: true });
    const after = await this.event(eventId).catch(() => null);
    const ok = !!after?.myBooking;
    return { ok, via: r.via, status: r.status, serverError: r.serverError, result: ok ? undefined : r.result, booking: after?.myBooking ?? null, event: after?.event ?? info.event, option: opt.title, paymentMethod: pm.label, cancelBy: after?.myBooking?.cancellation?.deadline ?? null };
  }

  /** Cancel by bookingId or eventId. Refuses late cancellations (inside the 8 h window → fee) unless force. */
  async cancel({ bookingId, eventId, force = false }) {
    let info = null;
    if (eventId) { info = await this.event(eventId); if (!info.myBooking) return { ok: true, alreadyCancelled: true, event: info.event }; bookingId = bookingId || info.myBooking.bookingId; }
    if (!bookingId) throw new Error('need bookingId or eventId');
    const policy = info?.myBooking?.cancellation;
    if (policy?.late && !force) throw new Error(`Late cancellation: inside the ${policy.windowHours} h window (deadline was ${policy.deadline}); fee ${policy.feeText ?? 'applies'}. Pass force to cancel anyway.`);
    const r = await this.#runAction('cancelBookingAction', [{ bookingId }], { eventId });
    const after = eventId ? await this.event(eventId).catch(() => null) : null;
    const ok = r.status === 200 && !r.serverError && (!after || !after.myBooking);
    return { ok, via: r.via, status: r.status, serverError: r.serverError, result: ok ? undefined : r.result, bookingId, event: after?.event ?? info?.event ?? null };
  }

  async waitlist({ eventId, action }) {
    if (action !== 'join' && action !== 'leave') throw new Error('action must be join|leave');
    const r = await this.#runAction(action === 'join' ? 'joinWaitlistAction' : 'leaveWaitlistAction', [{ eventId }], { eventId, preferPage: action === 'join' });
    const after = await this.event(eventId).catch(() => null);
    return { ok: r.status === 200 && !r.serverError, via: r.via, serverError: r.serverError, result: r.result, waitlistPosition: after?.waitlistPosition ?? null, waitlistedUsers: after?.waitlistedUsers ?? null, event: after?.event ?? null };
  }

  async status() {
    const cookies = this.http?.cookies || [];
    let signedIn = false, userId = null, err = null;
    try { const t = await this.http.rsc('/booking'); signedIn = true; const m = t.match(/"currentUser":\{[^}]*?"id":"([^"]+)"/); userId = m ? m[1] : null; } catch (e) { err = e.message; }
    let actionsInfo = null;
    try { const a = JSON.parse(await readFile(ACTIONS_FILE, 'utf8')); actionsInfo = { key: a.key, discoveredAt: a.discoveredAt, names: Object.keys(a.actions) }; } catch { /* none */ }
    return { signedIn, userId, error: err, cookies: cookies.length, actions: actionsInfo, headless: this.headless, rules: RULES, cacheTtlMs: this.cacheTtlMs };
  }
}
