// AlteaClient: the typed API surface over myaltea.app.
//
// Reads  = GET <page>?params with `RSC: 1`  → parse rows → slim JSON.
// Writes = Next.js server actions (ids discovered per build, see discover.mjs).
//   cancel / waitlist-leave → POST "/" from Node (unguarded route, fast).
//   book / waitlist-join    → POST "/booking/<eventId>" inside a real Chrome page (bot-guarded route;
//                             hidden window by default, visible fallback; headless is refused for bookings).

import { readFile, writeFile } from 'node:fs/promises';
import { HttpSession, ORIGIN, ACTIONS_FILE, META_FILE, getTZ, openBrowser, exportCookies, inPageAction } from './session.mjs';
import { parseRSC, eventsFromRows, deepFindInRows, parseActionResponse } from './rsc.mjs';
import { discoverActions } from './discover.mjs';
import { AlteaError } from './errors.mjs';

export const DEFAULT_GROUP = process.env.ALTEA_DEFAULT_GROUP || 'Boutique Fitness';
export const ALL_GROUPS = 'all';

/**
 * Membership rules. Values reported by the app win when present; these are the documented fallbacks and
 * what the tool descriptions promise. Override per membership with ALTEA_CANCEL_WINDOW_MIN / ALTEA_BOOKING_WINDOW_MIN.
 */
export const RULES = {
  cancelWindowMin: Number(process.env.ALTEA_CANCEL_WINDOW_MIN ?? 8 * 60),    // cancel ≥ 8 h before start, else the late fee
  bookingWindowMin: Number(process.env.ALTEA_BOOKING_WINDOW_MIN ?? 48 * 60), // booking opens 48 h before start
};

/** Colloquial group names → calendar group names. */
export const GROUP_ALIASES = {
  courts: 'Pickleball', court: 'Pickleball', pickle: 'Pickleball',
  recovery: 'Recovery & Wellness', lounge: 'Recovery & Wellness', massage: 'Recovery & Wellness', wellness: 'Recovery & Wellness', sauna: 'Recovery & Wellness',
  kids: 'Active Kids Club', child: 'Active Kids Club', children: 'Active Kids Club',
  pool: 'Aquatics', swim: 'Aquatics', swimming: 'Aquatics', aqua: 'Aquatics',
  rx: 'Personalized Performance', training: 'Personalized Performance', pt: 'Personalized Performance', performance: 'Personalized Performance', personal: 'Personalized Performance',
  boutique: 'Boutique Fitness', classes: 'Boutique Fitness', class: 'Boutique Fitness', studio: 'Boutique Fitness', gym: 'Boutique Fitness', fitness: 'Boutique Fitness',
};

// ---------- dates & times ("local" = the club's time zone, see getTZ) ----------

const fmtCache = new Map();
function fmtFor(tz) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'shortOffset' }); fmtCache.set(tz, f); }
  return f;
}
const pad2 = (n) => String(n).padStart(2, '0');
function offsetFor(d, tz) {
  const local = new Date(d.toLocaleString('en-US', { timeZone: tz }));
  const min = Math.round((local - d) / 60_000);
  const sign = min < 0 ? '-' : '+'; const a = Math.abs(min);
  return `${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

export function localParts(dateLike, tz = getTZ()) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(fmtFor(tz).formatToParts(d).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  const off = (p.timeZoneName || '').replace('GMT', '');
  const offNorm = /^[+-]\d{1,2}(:\d{2})?$/.test(off) ? (off.includes(':') ? off.replace(/^([+-])(\d):/, '$10$2:') : off.replace(/^([+-])(\d{1,2})$/, (m, s, h) => `${s}${h.padStart(2, '0')}:00`)) : offsetFor(d, tz);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}`, iso: `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}${offNorm}`, epoch: d.getTime(), tz };
}

export function todayLocal() { return localParts(new Date()).date; }
export function addDays(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
export function toDDMMYYYY(ymd) { const [y, m, d] = ymd.split('-'); return `${d}-${m}-${y}`; }
export function weekdayOf(ymd) { const [y, m, d] = ymd.split('-').map(Number); return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; }
const isRealDate = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d; };
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * YYYY-MM-DD | DD-MM-YYYY | today | tomorrow | yesterday | mon..sun (next such day, today included) | next mon | +N
 * | a full date with a year ("Oct 5 2026"). Bare month/day strings without a year are rejected rather than guessed.
 */
export function resolveDate(input, today = todayLocal()) {
  if (input == null || input === '' || input === 'today') return today;
  const s = String(input).trim().toLowerCase();
  if (s === 'tomorrow' || s === 'tmrw') return addDays(today, 1);
  if (s === 'yesterday') return addDays(today, -1);
  if (/^\+\d+$/.test(s)) return addDays(today, Number(s.slice(1)));
  if (/^-\d+$/.test(s)) return addDays(today, -Number(s.slice(1)));
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { if (!isRealDate(s)) throw new AlteaError('BAD_INPUT', `Not a real date: ${input}`); return s; }
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) { const [d, m, y] = s.split('-'); const out = `${y}-${m}-${d}`; if (!isRealDate(out)) throw new AlteaError('BAD_INPUT', `Not a real date: ${input}`); return out; }
  const m = s.match(/^(?:(next|this)\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/);
  if (m) { const wd = WEEKDAYS.indexOf(m[2]); const skipToday = m[1] === 'next'; for (let i = skipToday ? 1 : 0; i < 8; i++) { const c = addDays(today, i); if (WEEKDAYS[new Date(c + 'T00:00:00Z').getUTCDay()] === WEEKDAYS[wd]) return c; } }
  if (/\b(19|20)\d{2}\b/.test(s)) {
    const t = Date.parse(input);
    if (!Number.isNaN(t)) { const dt = new Date(t); const y = dt.getFullYear(); const ty = Number(today.slice(0, 4)); if (y >= ty - 1 && y <= ty + 2) return `${y}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`; } // Date.parse used the system zone; read it back the same way
  }
  throw new AlteaError('BAD_INPUT', `Unrecognised date: "${input}". Use YYYY-MM-DD, today, tomorrow, mon..sun, "next mon", +N, or "this week" / "next week" / "weekend" as a range.`);
}

/** Range keywords → { date, days }; null when the input is a plain date. */
export function resolveRange(input, today = todayLocal()) {
  const s = String(input ?? '').trim().toLowerCase();
  const dow = new Date(today + 'T00:00:00Z').getUTCDay(); // 0 = Sun
  const toSunday = dow === 0 ? 0 : 7 - dow;
  if (s === 'this week' || s === 'week') return { date: today, days: toSunday + 1 };
  if (s === 'next week') { const mon = addDays(today, toSunday + 1); return { date: mon, days: 7 }; }
  if (s === 'weekend' || s === 'this weekend' || s === 'next weekend') {
    let sat = today; while (new Date(sat + 'T00:00:00Z').getUTCDay() !== 6) sat = addDays(sat, 1);
    if (dow === 0 && s !== 'next weekend') return { date: today, days: 1 };
    if (s === 'next weekend' && (dow === 6 || dow === 0)) sat = addDays(sat, 7);
    return { date: sat, days: 2 };
  }
  if (s === 'today' || s === 'tomorrow') return { date: resolveDate(s, today), days: 1 };
  return null;
}

/** '15:00' | '3pm' | '3 pm' | '3:30pm' | '15h' | '1500' → 'HH:MM'. Bare 1..11 without am/pm is rejected as ambiguous. */
export function parseTime(input) {
  if (input == null || input === '') return null;
  const s = String(input).trim().toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm|h)?$/);
  if (!m) throw new AlteaError('BAD_INPUT', `Unrecognised time: ${input} (use 15:00 or 3pm)`);
  let h = Number(m[1]); const min = Number(m[2] || 0); const ap = m[3];
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (!ap && h >= 1 && h <= 11 && m[2] === undefined) throw new AlteaError('BAD_INPUT', `Ambiguous time "${input}": add am/pm or use 24 h (e.g. 15:00).`);
  if (h > 23 || min > 59) throw new AlteaError('BAD_INPUT', `Unrecognised time: ${input}`);
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
  if (!ev.time) return !(f.after || f.before || f.at || f.timeOfDay);
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
  const enabled = c ? (c.enabled === undefined ? true : !!c.enabled) : true;
  const windowMin = src.cancellationWindow ?? fallback?.cancelWindowMin ?? null;
  const feeCents = src.cancellationPrice ?? null;
  const deadline = startMs && windowMin != null ? startMs - windowMin * 60_000 : null;
  return {
    enabled,
    windowHours: windowMin != null ? windowMin / 60 : null,
    feeCents,
    feeText: feeCents != null ? `$${(feeCents / 100).toFixed(2)}${feeCents ? ' + tax' : ''}` : null,
    deadline: enabled && deadline ? localParts(deadline).iso : null,
    late: enabled && deadline ? Date.now() > deadline : null,
    text: enabled ? (src.shortText ?? (windowMin != null ? `${windowMin / 60} hours before the event` : null)) : 'not cancellable',
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

/** Union two reference-data sets by id (the app only sends the lists relevant to the day fetched). */
export function mergeMeta(prev, next) {
  prev = prev || {}; next = next || {};
  const byId = (a = [], b = []) => { const m = new Map(); for (const x of [...a, ...b]) if (x && x.id) m.set(x.id, x); return [...m.values()]; };
  return {
    types: byId(prev.types, next.types).sort((a, b) => a.label.localeCompare(b.label)),
    instructors: byId(prev.instructors, next.instructors).sort((a, b) => a.name.localeCompare(b.name)),
    communities: next.communities?.length ? next.communities : (prev.communities || []),
    defaultCommunityId: next.defaultCommunityId || prev.defaultCommunityId || null,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

// ---------- the client ----------

export class Altea {
  #cache = new Map();

  // Window mode for the guarded in-page actions (book, waitlist join). ALTEA_WINDOW=visible|hidden|headless|auto.
  // auto = try the quiet mode first (hidden), then fall back to a visible window when the backend refuses.
  constructor({ log = () => {}, headless = process.env.ALTEA_HEADLESS === '1', windowMode = process.env.ALTEA_WINDOW || (process.env.ALTEA_HEADLESS === '1' ? 'headless' : 'auto'), cacheTtlMs = Number(process.env.ALTEA_CACHE_TTL_MS ?? 45_000), concurrency = Number(process.env.ALTEA_CONCURRENCY ?? 8) } = {}) {
    this.log = log; this.headless = headless; this.windowMode = windowMode; this.cacheTtlMs = cacheTtlMs; this.concurrency = concurrency;
    this.quietMode = process.env.ALTEA_QUIET_MODE || 'hidden'; // what "auto" tries first
    this.http = null; this.browser = null; this.page = null; this.actions = null; this._meta = null;
  }

  async init() { if (!this.http) this.http = await HttpSession.load(); return this; }

  async close() {
    await this.#closeBrowser();
    if (this.http) await this.http.persist();
  }

  clearCache() { this.#cache.clear(); }

  async #rsc(path, { nocache = false } = {}) {
    const hit = this.#cache.get(path);
    if (!nocache && hit && Date.now() - hit.t < this.cacheTtlMs) return hit.text;
    const text = await this.http.rsc(path);
    if (this.#cache.size >= 60) this.#cache.delete(this.#cache.keys().next().value); // bounded (payloads are 0.1–1 MB)
    this.#cache.set(path, { t: Date.now(), text });
    return text;
  }

  // ----- resolution helpers -----

  /** Default club: ALTEA_COMMUNITY (id or name) → cached detection → the club the app renders by default → first known. */
  #adoptTZ(m, cid) {
    if (process.env.ALTEA_TZ) return;
    const club = (m?.communities || []).find((c) => c.id === cid);
    if (club?.timezone) globalThis.__ALTEA_TZ = club.timezone;
  }

  async defaultCommunityId() {
    const env = process.env.ALTEA_COMMUNITY;
    const m = await this.meta();
    if (env?.startsWith('com_')) { this.#adoptTZ(m, env); return env; }
    if (env) { const hit = m.communities.find((c) => c.name.toLowerCase().includes(env.toLowerCase())); if (hit) { this.#adoptTZ(m, hit.id); return hit.id; } }
    const cid = m.defaultCommunityId || m.communities[0]?.id;
    if (cid) { this.#adoptTZ(m, cid); return cid; }
    throw new AlteaError('UPSTREAM', 'Could not determine your club; set ALTEA_COMMUNITY to its name or com_ id.');
  }

  async resolveCommunity(input) {
    if (!input) return this.defaultCommunityId();
    if (input.startsWith('com_')) return input;
    const m = await this.meta();
    const hit = m.communities.find((c) => c.name.toLowerCase().includes(input.toLowerCase()));
    if (!hit) throw new AlteaError('BAD_INPUT', `unknown community "${input}"; known: ${m.communities.map((c) => c.name).join(', ')}`);
    return hit.id;
  }

  async resolveGroup(communityId, input) {
    const m = await this.meta();
    const c = m.communities.find((x) => x.id === communityId);
    const groups = c?.groups || [];
    if (!input) return groups.includes(DEFAULT_GROUP) ? DEFAULT_GROUP : (groups[0] || DEFAULT_GROUP);
    const key = norm(input);
    const aliased = GROUP_ALIASES[key] || GROUP_ALIASES[key.split(' ')[0]];
    const hit = groups.find((g) => g.toLowerCase() === input.toLowerCase())
      || (aliased && groups.find((g) => g === aliased))
      || groups.find((g) => g.toLowerCase().includes(input.toLowerCase()))
      || groups.find((g) => norm(g).split(' ').some((w) => w.startsWith(key)));
    if (!hit) throw new AlteaError('BAD_INPUT', `unknown calendar group "${input}" for ${c?.name || communityId}; known: ${groups.join(', ')}, or "all"`);
    return hit;
  }

  /** undefined → [default group]; "all" → every group of the club; otherwise one resolved group. */
  async groupsFor(communityId, group) {
    if (group === ALL_GROUPS || group === '*') {
      const m = await this.meta();
      const c = m.communities.find((x) => x.id === communityId);
      return c?.groups?.length ? c.groups : [DEFAULT_GROUP];
    }
    return [await this.resolveGroup(communityId, group)];
  }

  // ----- reads -----

  schedulePath(ymd, group, communityId) {
    const q = new URLSearchParams({ date: toDDMMYYYY(ymd), calendarGroup: group, communityId });
    return `/booking?${q.toString()}`;
  }

  /** One day, one calendar group. */
  async day(ymd, { group, communityId, withDescription = false, nocache = false } = {}) {
    const cid = communityId || await this.defaultCommunityId();
    const g = group || await this.resolveGroup(cid);
    const t0 = Date.now();
    const text = await this.#rsc(this.schedulePath(ymd, g, cid), { nocache });
    const rows = parseRSC(text);
    const events = eventsFromRows(rows).map((e) => ({ ...slimEvent(e, { withDescription }), group: g }));
    events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    this._meta = mergeMeta(this._meta, this.#metaFromRows(rows, text));
    this.log(`schedule ${ymd} ${g}: ${events.length} events, ${text.length}B, ${Date.now() - t0}ms`);
    return { date: ymd, weekday: weekdayOf(ymd), group: g, communityId: cid, events };
  }

  /**
   * Range of days × one or all calendar groups, fetched in parallel, merged per day, filtered.
   * filters: instructor, type, studio, query, availableOnly, mine, after, before, at, near, timeOfDay
   * `date` also accepts range words: "this week", "next week", "weekend" (they set `days`).
   */
  async schedule({ date = 'today', days, group, community, communityId, withDescription = false, concurrency, nocache = false, ...rawFilters } = {}) {
    const cid = communityId || await this.resolveCommunity(community);
    const groups = await this.groupsFor(cid, group);
    const filters = normaliseFilters(rawFilters);
    const range = resolveRange(date);
    const start = range ? range.date : resolveDate(date);
    const nDays = Math.max(1, Math.min(Number(days) || (range ? range.days : 1), 45));
    const dates = Array.from({ length: nDays }, (_, i) => addDays(start, i));
    const jobs = dates.flatMap((d) => groups.map((g) => ({ d, g })));
    const results = await mapLimit(jobs, concurrency || this.concurrency, ({ d, g }) => this.day(d, { group: g, communityId: cid, withDescription, nocache }).catch((e) => ({ date: d, group: g, events: [], error: e.message })));
    const byDate = new Map(dates.map((d) => [d, { date: d, weekday: weekdayOf(d), events: [], errors: [] }]));
    for (const r of results) {
      const slot = byDate.get(r.date);
      if (r.error) slot.errors.push(`${r.group}: ${r.error}`);
      for (const e of r.events) if (!slot.events.some((x) => x.id === e.id)) slot.events.push(e);
    }
    const hasFilter = Object.keys(filters).some((k) => filters[k] !== undefined && filters[k] !== false && filters[k] !== null && filters[k] !== '');
    const out = [];
    const today = todayLocal();
    for (const slot of byDate.values()) {
      slot.events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
      if (hasFilter) slot.events = slot.events.filter((e) => matchesFilters(e, filters));
      if (!slot.errors.length) delete slot.errors;
      if (slot.date < today) slot.note = 'past day: the app does not show sessions that already happened';
      else if (slot.date === today && slot.events.length === 0) slot.note = 'today: sessions that already started are not shown';
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
    if (!name) throw new AlteaError('BAD_INPUT', 'instructor name required');
    const res = await this.schedule({ date, days, group, ...rest });
    const all = res.days.flatMap((d) => d.events);
    const sessions = all.filter((e) => e.instructors.some((n) => norm(n).includes(norm(name))));
    const matched = [...new Set(sessions.flatMap((e) => e.instructors.filter((n) => norm(n).includes(norm(name)))))];
    const seen = [...new Set(all.flatMap((e) => e.instructors))];
    const metaNames = (this._meta?.instructors || []).map((i) => i.name);
    const suggestions = sessions.length ? [] : rankNames(name, [...seen, ...metaNames]).slice(0, 6);
    return { name, matchedNames: matched, ambiguous: matched.length > 1, from: res.from, to: res.to, groups: res.groups, count: sessions.length, sessions, instructorsSeen: seen.length, suggestions };
  }

  /**
   * The next future occurrence of something ("hot yin", "main stage ride", instructor "sara", type "cycle"):
   * first match at all, first match with spots, waitlist size and booking-window info for the first.
   */
  async next({ query, instructor, type, studio, from = 'today', days = 14, group = ALL_GROUPS, community, communityId, chunk = 3, after, before, timeOfDay, availableOnly } = {}) {
    if (!query && !instructor && !type && !studio) throw new AlteaError('BAD_INPUT', 'next: give a query, instructor, type or studio');
    const start = resolveDate(from); const now = Date.now();
    let first = null, firstOpen = null, scannedThrough = start;
    for (let i = 0; i < days && !(first && firstOpen); i += chunk) {
      const n = Math.min(chunk, days - i);
      const res = await this.schedule({ date: addDays(start, i), days: n, group, community, communityId, query, instructor, type, studio, after, before, timeOfDay, availableOnly });
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
        detail = { waitlistedUsers: d.waitlistedUsers, myBooking: d.myBooking, bookableFrom: d.bookingWindow?.bookableFrom ?? null, bookableNow: d.bookingWindow?.bookableNow ?? null, cancellation: d.options[0]?.cancellation ?? shapePolicy(null, Date.parse(first.start)) };
      } catch { /* detail is optional */ }
    }
    return { query: query || instructor || type || studio, from: start, searchedThrough: scannedThrough, next: first, nextWithSpots: firstOpen, sameEvent: !!(first && firstOpen && first.id === firstOpen.id), detail };
  }

  #metaFromRows(rows, text = '') {
    const isList = (j, prefix) => Array.isArray(j) && j.length > 0 && j[0] && typeof j[0].id === 'string' && j[0].id.startsWith(prefix) && 'label' in j[0];
    const types = deepFindInRows(rows, (j) => isList(j, 'evttag_'));
    const instructors = deepFindInRows(rows, (j) => isList(j, 'res_'));
    const communities = deepFindInRows(rows, (j) => Array.isArray(j) && j.length > 0 && j[0] && typeof j[0].communityId === 'string' && Array.isArray(j[0].calendarGroups));
    const def = (text.match(/"communityId":"(com_[A-Za-z0-9]+)","eventTypesPromise"/) || [])[1] || null;
    return {
      types: types ? types.map((t) => ({ id: t.id, label: t.label })) : [],
      instructors: instructors ? instructors.map((r) => ({ id: r.id, name: r.label })) : [],
      communities: communities ? communities.map((c) => ({ id: c.communityId, name: c.communityName, timezone: c.timezone, groups: c.calendarGroups })) : [],
      defaultCommunityId: def,
    };
  }

  /** Event types, instructors, communities + their calendar groups, default club (cached on disk for 7 days). */
  async meta({ refresh = false } = {}) {
    if (!refresh) {
      if (this._meta?.communities?.length && this._meta?.types?.length && this._meta?.defaultCommunityId) return { ...this._meta, rules: RULES };
      try { const m = JSON.parse(await readFile(META_FILE, 'utf8')); if (m.communities?.length && m.types?.length && m.instructors?.length && m.defaultCommunityId && Date.now() - Date.parse(m.savedAt) < 7 * 86_400_000) { this._meta = mergeMeta(this._meta, m); return { ...this._meta, rules: RULES }; } } catch { /* none */ }
    }
    // The bare /booking page renders the member's default club and its reference lists.
    const text = await this.#rsc('/booking', { nocache: refresh });
    this._meta = mergeMeta(this._meta, this.#metaFromRows(parseRSC(text), text));
    const cid = this._meta.defaultCommunityId || this._meta.communities[0]?.id;
    for (let i = 0; i < 4 && cid && !(this._meta.types?.length && this._meta.instructors?.length); i++) await this.day(addDays(todayLocal(), i), { communityId: cid, group: DEFAULT_GROUP });
    const m = { ...this._meta, savedAt: new Date().toISOString() };
    await writeFile(META_FILE, JSON.stringify(m, null, 2)).catch(() => {});
    this._meta = m;
    return { ...m, rules: RULES };
  }

  /** Event detail + my booking context (perks, policy, payment methods, agreements). Never cached. */
  async event(eventId) {
    if (!/^evt_[A-Za-z0-9_]+$/.test(eventId)) throw new AlteaError('BAD_INPUT', `bad eventId: ${eventId} (expected evt_…)`);
    const text = await this.http.rsc(`/booking/${eventId}`);
    const rows = parseRSC(text);
    const ev = deepFindInRows(rows, (j) => j && typeof j === 'object' && !Array.isArray(j) && j.id === eventId && 'startDate' in j);
    const ctx = deepFindInRows(rows, (j) => j && typeof j === 'object' && !Array.isArray(j) && 'activeBookings' in j && 'context' in j);
    if (!ev && !ctx) throw new AlteaError('NOT_FOUND', `event ${eventId}: not found (wrong id, or event removed)`);
    return this.#shapeEvent(ev ?? null, ctx ?? null, eventId);
  }

  #shapeEvent(ev, ctx, eventId) {
    const out = { id: eventId, event: ev ? slimEvent(ev, { withDescription: true }) : null };
    if (!ctx) return out;
    const me = ctx.context?.currentUser || {};
    const pairs = (ctx.activeBookings || []).filter((p) => p?.[1]?.id?.startsWith?.('bkg_'));
    const mine = pairs.find((p) => me.id && p[0]?.id === me.id) || (me.id ? null : pairs[0]) || null; // never a linked account's booking
    const booking = mine ? mine[1] : null;
    const startMs = ev ? Date.parse(ev.startDate) : null;
    out.myBooking = booking ? { bookingId: booking.id, status: booking.status ?? null, perk: booking.perk?.title ?? null, cancellation: shapePolicy(booking.perk?.cancellation, startMs) } : null;
    out.othersBooked = pairs.length - (mine ? 1 : 0);
    out.options = (me.perks || []).map((p) => {
      const win = p.bookingWindow ?? RULES.bookingWindowMin;
      const bookableFrom = startMs ? localParts(startMs - win * 60_000).iso : null;
      return {
        perkId: p.perkId, userPerkId: p.userPerkId, title: p.title ?? null, price: p.price ?? 0, unlimited: !!p.unlimited, disabled: !!p.disabled,
        bookingWindowMin: win, bookingWindowSource: p.bookingWindow != null ? 'app' : 'rules',
        bookableFrom, bookableNow: bookableFrom ? Date.parse(bookableFrom) <= Date.now() : null,
        dailyMaxUsages: p.dailyMaxUsages ?? null, dailyUsages: p.dailyUsages ?? 0,
        cancellation: shapePolicy(p.cancellation, startMs),
      };
    });
    const opens = out.options.map((o) => o.bookableFrom).filter(Boolean).sort()[0] || (startMs ? localParts(startMs - RULES.bookingWindowMin * 60_000).iso : null);
    out.bookingWindow = { bookableFrom: opens, bookableNow: opens ? Date.parse(opens) <= Date.now() : null, source: out.options.some((o) => o.bookingWindowSource === 'app') ? 'app' : 'rules', usableOptions: out.options.filter((o) => !o.disabled).length };
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

  /**
   * My bookings. The Bookings page returns one upcoming window (today → +3 months) whatever the date, plus a per-day
   * count row for the calendar month selected with date=DD-MM-YYYY; past details are not available.
   */
  async bookings({ from = 'today', to, days = 30 } = {}) {
    const start = resolveDate(from);
    const end = to ? resolveDate(to) : addDays(start, Number(days) || 30);
    const text = await this.http.rsc(`/?date=${toDDMMYYYY(start)}`);
    const rows = parseRSC(text);
    const items = this.#bookingsFromRows(rows).filter((b) => b.date >= start && b.date <= end).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    const counts = new Map();
    const addCounts = (r) => { const c = deepFindInRows(r, (j) => Array.isArray(j) && j.length > 0 && Array.isArray(j[0]) && /^\d{4}-\d{2}-\d{2}$/.test(j[0][0]) && j[0][1] && typeof j[0][1] === 'object' && 'bookings' in j[0][1]); for (const [d, v] of c || []) if (d >= start && d <= end) counts.set(d, v.bookings); };
    addCounts(rows);
    // extra months in range (one fetch each) for the per-day counts
    for (let m = start.slice(0, 7); m <= end.slice(0, 7); ) { const next = addDays(m + '-01', 32).slice(0, 7); if (m !== start.slice(0, 7)) { try { addCounts(parseRSC(await this.http.rsc(`/?date=01-${m.slice(5, 7)}-${m.slice(0, 4)}`))); } catch { /* ignore */ } } if (next <= end.slice(0, 7)) m = next; else break; }
    const today = todayLocal();
    const dates = [...counts.keys()].sort();
    return { from: start, to: end, datesWithBookings: dates, pastCounts: Object.fromEntries(dates.filter((d) => d < today).map((d) => [d, counts.get(d)])), count: items.length, bookings: items, note: start < today ? 'past bookings are counted per day but their details are not available from the app' : undefined };
  }

  #bookingsFromRows(rows) {
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
        date: ev?.date ?? (b.date ? localParts(b.date)?.date : null),
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

  async #page(mode) {
    if (this.page && this.browser?.mode !== mode) await this.#closeBrowser();
    if (!this.page) {
      this.browser = await openBrowser({ mode, log: this.log });
      this.browser.mode = mode;
      this.page = this.browser.context.pages()[0] || (await this.browser.context.newPage());
    }
    return this.page;
  }

  async #closeBrowser() {
    if (!this.browser) return;
    try { await exportCookies(this.browser.context); if (this.http) await this.http.refresh(); } catch { /* ignore */ }
    await this.browser.close().catch(() => {});
    this.browser = null; this.page = null;
  }

  /** Did the backend refuse the action because it judged the page to be a bot? */
  static refusedAsBot(parsed) {
    const msg = parsed?.result?.data?.message || parsed?.serverError || '';
    return parsed?.result?.data?.success === false && /unable to process/i.test(String(msg));
  }

  /** Fast path first (POST "/"), then the in-page path if the route rejects or the action is unknown there. */
  async #runAction(name, args, { eventId, preferPage = false } = {}) {
    const actions = await this.ensureActions({ eventId });
    const id = actions[name];
    if (!id) throw new AlteaError('UNKNOWN_ACTION', `server action ${name} not found in the current build`);
    const t0 = Date.now();
    if (!preferPage) {
      const r = await this.http.action('/', id, args);
      const parsed = parseActionResponse(r.text);
      const unknown = /Failed to find Server Action|Server Action .* was not found/i.test(r.text);
      if (r.status === 200 && !unknown) { this.log(`${name}: fast path ${Date.now() - t0}ms`); this.clearCache(); return { via: 'http', status: r.status, revalidated: r.revalidated, result: this.#stripResult(parsed.result), serverError: parsed.serverError }; }
      this.log(`${name}: fast path unavailable (${r.status}${unknown ? ', unknown on /' : ''}), using page`);
    }
    const modes = this.windowMode === 'auto' ? [this.quietMode, 'visible'] : [this.windowMode];
    let r, parsed, usedMode;
    try {
      for (const mode of modes) {
        const page = await this.#page(mode);
        r = await inPageAction(page, eventId ? `/booking/${eventId}` : '/booking', id, args);
        parsed = parseActionResponse(r.text);
        usedMode = mode;
        await this.#closeBrowser(); // never leave a window (or a hidden Chrome) behind
        if (Altea.refusedAsBot(parsed) && mode !== modes[modes.length - 1]) { this.log(`${name}: refused in ${mode} mode, retrying ${modes[modes.indexOf(mode) + 1]}`); continue; }
        break;
      }
    } finally { await this.#closeBrowser(); }
    this.log(`${name}: page path (${usedMode}) ${Date.now() - t0}ms`);
    this.clearCache();
    return { via: `page:${usedMode}`, status: r.status, revalidated: r.revalidated, result: this.#stripResult(parsed.result), serverError: parsed.serverError, raw: r.status !== 200 ? r.text.slice(0, 500) : undefined };
  }

  #stripResult(result) {
    if (result?.data && typeof result.data === 'object') { const { email, userId, ...rest } = result.data; return { ...result, data: rest }; } // no PII in results
    return result;
  }

  // ----- actions -----

  /**
   * Book an event. Builds the exact payload the web app sends. Guards: booking window, unsigned waiver (never bypassed),
   * schedule conflict, full event, paid membership options (never chosen implicitly). `force` overrides window/conflict/full only.
   */
  async book({ eventId, perkId, paymentMethodId, force = false }) {
    const info = await this.event(eventId);
    if (!info.event) throw new AlteaError('NOT_FOUND', 'event not found');
    if (info.myBooking) return { ok: true, alreadyBooked: true, booking: info.myBooking, event: info.event };
    if (info.unsignedAgreements.length) throw new AlteaError('UNSIGNED_AGREEMENT', `Unsigned agreement(s) required in the app first: ${info.unsignedAgreements.join(', ')}`);
    if (info.conflicts.length && !force) throw new AlteaError('CONFLICT', 'Schedule conflict with an existing booking', { details: info.conflicts });
    const opts = info.options.filter((o) => !o.disabled);
    if (!opts.length) {
      const w = info.bookingWindow;
      if (w?.bookableFrom && !w.bookableNow && !force) throw new AlteaError('WINDOW_NOT_OPEN', `Booking window not open yet: opens ${w.bookableFrom} (${RULES.bookingWindowMin / 60} h before start; the event starts ${info.event.start}).`, { details: { opensAt: w.bookableFrom, start: info.event.start } });
      throw new AlteaError('NO_MEMBERSHIP', info.options.length ? 'All membership options are disabled for this event.' : 'No usable membership/perk for this event on your account.');
    }
    let opt = perkId ? opts.find((o) => o.perkId === perkId) : null;
    if (perkId && !opt) throw new AlteaError('BAD_INPUT', `perk ${perkId} is not offered for this event`);
    if (!opt && info.defaultOption) { const m = info.defaultOption.match(/__own__([^|]+)\|([^|]+)\|/); if (m) opt = opts.find((o) => o.perkId === m[1] && o.userPerkId === m[2]); }
    if (!opt) opt = opts.find((o) => o.unlimited || !(o.price > 0));
    if (!opt) throw new AlteaError('PAID_OPTION', `Only paid options are offered (${opts.map((o) => `${o.title} $${(o.price / 100).toFixed(2)}`).join(', ')}); pass perkId explicitly to buy one.`, { details: opts.map((o) => ({ perkId: o.perkId, title: o.title, price: o.price })) });
    if (opt.price > 0 && !perkId) throw new AlteaError('PAID_OPTION', `The default option "${opt.title}" costs $${(opt.price / 100).toFixed(2)}; pass perkId explicitly to buy it.`, { details: { perkId: opt.perkId, price: opt.price } });
    if (opt.bookableFrom && Date.parse(opt.bookableFrom) > Date.now() && !force) throw new AlteaError('WINDOW_NOT_OPEN', `Booking window not open yet: opens ${opt.bookableFrom} (${opt.bookingWindowMin / 60} h before start). Event starts ${info.event.start}.`, { details: { opensAt: opt.bookableFrom, start: info.event.start } });
    const pm = paymentMethodId ? info.paymentMethods.find((p) => p.id === paymentMethodId) : (info.paymentMethods.find((p) => p.default && !p.expired) || info.paymentMethods.find((p) => !p.expired));
    if (!pm) throw new AlteaError('NO_MEMBERSHIP', 'No payment method on file (the app requires one for the late-cancellation fee).', { next: 'A card must be added in the Altea app by the member; never add one on their behalf.' });
    if (info.event.full && !force) throw new AlteaError('EVENT_FULL', 'Event is full (0 spots).');
    const args = [{ eventId, bookings: [{ agreements: [], equipment: '$undefined', paymentMethodId: pm.id, perkId: opt.perkId, perkUserId: info.userId, price: opt.price ?? 0, userPerkId: opt.userPerkId, userId: info.userId }] }];
    this.log(`book ${eventId} with "${opt.title}" (price ${opt.price ?? 0})`);
    const r = await this.#runAction('confirmBookingAction', args, { eventId, preferPage: true });
    const after = await this.event(eventId).catch(() => null);
    const ok = !!after?.myBooking;
    return { ok, via: r.via, status: r.status, serverError: r.serverError, result: ok ? undefined : r.result, booking: after?.myBooking ?? null, event: after?.event ?? info.event, option: opt.title, paymentMethod: pm.label, cancelBy: after?.myBooking?.cancellation?.deadline ?? null };
  }

  /** Cancel by bookingId or eventId. Always checks the policy; refuses late cancellations (fee) unless force. */
  async cancel({ bookingId, eventId, force = false }) {
    let info = null, policy = null, title = null;
    if (eventId) {
      info = await this.event(eventId);
      if (!info.myBooking) return { ok: true, alreadyCancelled: true, event: info.event };
      bookingId = bookingId || info.myBooking.bookingId;
      policy = info.myBooking.cancellation;
    } else {
      if (!bookingId) throw new AlteaError('BAD_INPUT', 'need bookingId or eventId');
      const mine = (await this.bookings({ days: 120 })).bookings.find((b) => b.bookingId === bookingId);
      if (!mine) throw new AlteaError('NOT_FOUND', `booking ${bookingId} is not among your upcoming bookings`);
      eventId = mine.eventId; policy = mine.cancellation; title = mine.title;
      if (mine.canCancel === false && !force) throw new AlteaError('LATE_CANCEL', `The app marks this booking as not cancellable (${title}).`);
    }
    if (policy && policy.enabled === false && !force) throw new AlteaError('LATE_CANCEL', 'This booking is not cancellable under its policy.');
    if (policy?.late && !force) throw new AlteaError('LATE_CANCEL', `Late cancellation: inside the ${policy.windowHours} h window (deadline was ${policy.deadline}); fee ${policy.feeText ?? 'applies'}.`, { details: { deadline: policy.deadline, fee: policy.feeText } });
    const r = await this.#runAction('cancelBookingAction', [{ bookingId }], { eventId });
    const after = eventId ? await this.event(eventId).catch(() => null) : null;
    const ok = r.status === 200 && !r.serverError && (!after || !after.myBooking);
    return { ok, via: r.via, status: r.status, serverError: r.serverError, result: ok ? undefined : r.result, bookingId, event: after?.event ?? info?.event ?? null };
  }

  async waitlist({ eventId, action }) {
    if (action !== 'join' && action !== 'leave') throw new AlteaError('BAD_INPUT', 'action must be join|leave');
    const r = await this.#runAction(action === 'join' ? 'joinWaitlistAction' : 'leaveWaitlistAction', [{ eventId }], { eventId, preferPage: action === 'join' });
    const after = await this.event(eventId).catch(() => null);
    return { ok: r.status === 200 && !r.serverError && r.result?.data?.success !== false, via: r.via, serverError: r.serverError, result: r.result, waitlistPosition: after?.waitlistPosition ?? null, waitlistedUsers: after?.waitlistedUsers ?? null, event: after?.event ?? null };
  }

  async status() {
    const cookies = this.http?.cookies || [];
    let signedIn = false, userId = null, err = null;
    try { const t = await this.http.rsc('/booking'); signedIn = true; const m = t.match(/"currentUser":\{[^}]*?"id":"([^"]+)"/); userId = m ? m[1] : null; } catch (e) { err = e.message; }
    // the sign-in cookie decides when the session ends; short-lived helpers that share the jar (Stripe, tz) do not
    const authCookies = cookies.filter((c) => /auth|session/i.test(c.name) && c.expires > 0);
    const expiries = (authCookies.length ? authCookies : cookies.filter((c) => c.name !== 'tz' && c.expires > 0)).map((c) => c.expires * 1000);
    const sessionExpiresAt = expiries.length ? localParts(Math.min(...expiries)).iso : null;
    let actionsInfo = null;
    try { const a = JSON.parse(await readFile(ACTIONS_FILE, 'utf8')); actionsInfo = { key: a.key, discoveredAt: a.discoveredAt, names: Object.keys(a.actions) }; } catch { /* none */ }
    let defaultCommunity = null; try { const m = await this.meta(); const did = await this.defaultCommunityId(); defaultCommunity = m.communities.find((c) => c.id === did)?.name ?? null; } catch { /* ignore */ }
    return { signedIn, userId, error: err, cookies: cookies.length, sessionExpiresAt, defaultCommunity, actions: actionsInfo, windowMode: this.windowMode, rules: RULES, cacheTtlMs: this.cacheTtlMs };
  }
}
