// Token-lean renderings of client results for the model. `concise` (default) = short text lines a model reads
// well + a compact structured list; `detailed` = full objects (ids, urls, instructor ids, descriptions) for chained calls.

export const spotsText = (e) => (e.myStatus ? 'BOOKED' : e.waitlisted ? 'WAITLISTED' : e.full ? 'FULL' : `${e.spotsLeft} left`);
const spotsValue = (e) => (e.myStatus ? 'BOOKED' : e.waitlisted ? 'WAITLISTED' : e.full ? 'FULL' : e.spotsLeft);

export function eventLine(e, { group = false } = {}) {
  const who = e.instructors?.length ? ` · ${e.instructors.join(', ')}` : '';
  const g = group && e.group && e.group !== 'Boutique Fitness' ? ` [${e.group}]` : '';
  return `${e.time}-${e.end}  ${e.title} · ${e.studio}${who} · ${spotsText(e)}${g}  (${e.id})`;
}

/** Compact event object for structured output in concise mode. */
export function compactEvent(e) {
  const o = { id: e.id, time: e.time, title: e.title, studio: e.studio, spots: spotsValue(e) };
  if (e.instructors?.length) o.who = e.instructors.join(', ');
  if (e.group && e.group !== 'Boutique Fitness') o.group = e.group;
  return o;
}
/** Fuller but still lean object (ids, dates) for detailed mode. */
export function slimForModel(e) {
  return { id: e.id, date: e.date, time: e.time, end: e.end, title: e.title, studio: e.studio, instructors: e.instructors, spotsLeft: e.spotsLeft, full: e.full, myStatus: e.myStatus, waitlisted: e.waitlisted, group: e.group };
}
const pick = (format) => (format === 'detailed' ? (e) => e : compactEvent);

/**
 * Collapse long runs of identical slots (recovery pods every 15 min, courts every hour) into one series entry so a
 * day never costs hundreds of lines. Returns { singles, series } where series items summarise ≥ minRun same-title slots.
 */
export function collapseSeries(events, minRun = 6) {
  const groups = new Map();
  for (const e of events) { const k = `${e.title}|${e.studio}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  const singles = []; const series = [];
  for (const [, evs] of groups) {
    if (evs.length < minRun) { singles.push(...evs); continue; }
    const open = evs.filter((e) => !e.full && !e.myStatus);
    const mine = evs.filter((e) => e.myStatus || e.waitlisted);
    series.push({ title: evs[0].title, studio: evs[0].studio, group: evs[0].group, from: evs[0].time, to: evs[evs.length - 1].end || evs[evs.length - 1].time, count: evs.length, withSpots: open.length, nextOpen: open[0] ? compactEvent(open[0]) : null, openTimes: open.slice(0, 12).map((e) => e.time), mine: mine.map(compactEvent) });
  }
  singles.sort((a, b) => (a.time || '').localeCompare(b.time || '') || a.title.localeCompare(b.title));
  return { singles, series };
}
const seriesLine = (s) => `${s.from}-${s.to}  ${s.title} · ${s.studio} · ${s.count} slots, ${s.withSpots} with spots${s.nextOpen ? ` (next open ${s.nextOpen.time}, ${s.nextOpen.spots} left, ${s.nextOpen.id})` : ''}${s.openTimes.length > 1 ? ` · open at ${s.openTimes.join(' ')}${s.withSpots > s.openTimes.length ? ' …' : ''}` : ''}${s.mine.length ? ` · mine: ${s.mine.map((m) => m.time).join(', ')}` : ''}`;

export function capEvents(events, limit) {
  if (!limit || events.length <= limit) return { events, truncated: 0 };
  return { events: events.slice(0, limit), truncated: events.length - limit };
}

export function renderSchedule(res, { format = 'concise', limit = 60 } = {}) {
  const lines = []; const days = []; let truncatedTotal = 0;
  for (const d of res.days) {
    const { singles, series } = format === 'detailed' ? { singles: d.events, series: [] } : collapseSeries(d.events);
    const { events, truncated } = capEvents(singles, limit);
    truncatedTotal += truncated;
    lines.push(`${d.weekday} ${d.date} · ${res.groups.length > 1 ? 'all groups' : res.groups[0]} · ${d.events.length} events${d.note ? ` · ${d.note}` : ''}${d.errors ? ` · errors: ${d.errors.join('; ')}` : ''}`);
    for (const s of series) lines.push('  ' + seriesLine(s));
    for (const e of events) lines.push('  ' + eventLine(e, { group: res.groups.length > 1 }));
    if (truncated) lines.push(`  … ${truncated} more (narrow with instructor/type/studio/after/before/at, or raise limit)`);
    days.push({ date: d.date, weekday: d.weekday, count: d.events.length, events: events.map(pick(format)), series: series.length ? series : undefined, truncated: truncated || undefined, note: d.note, errors: d.errors });
  }
  const summary = `${res.count} events ${res.from}${res.to !== res.from ? '..' + res.to : ''}${res.filters ? ' (filtered)' : ''}${truncatedTotal ? `, ${truncatedTotal} not shown` : ''}`;
  return { text: [summary, ...lines].join('\n'), structured: { status: res.count ? 'success' : 'warning', summary, from: res.from, to: res.to, groups: res.groups, count: res.count, days } };
}

export function renderFind(res, opts = {}) {
  const r = renderSchedule(res, opts);
  return { text: r.text, structured: { ...r.structured, events: res.events.map(pick(opts.format)).slice(0, opts.limit || 60) } };
}

export function renderInstructor(res, { format = 'concise', limit = 60 } = {}) {
  if (!res.count) {
    const sugg = res.suggestions.length ? ` Did you mean: ${res.suggestions.join(', ')}?` : '';
    const text = `No sessions by "${res.name}" ${res.from}${res.to !== res.from ? '..' + res.to : ''} across ${res.groups.length} groups (${res.instructorsSeen} instructors seen).${sugg}`;
    return { text, structured: { status: 'warning', summary: text, name: res.name, from: res.from, to: res.to, count: 0, sessions: [], suggestions: res.suggestions, matchedNames: [] } };
  }
  const { events, truncated } = capEvents(res.sessions, limit);
  const lines = []; let last = null;
  for (const e of events) { if (e.date !== last) { lines.push(`${e.weekday} ${e.date}`); last = e.date; } lines.push('  ' + eventLine(e, { group: true })); }
  if (truncated) lines.push(`… ${truncated} more`);
  const who = res.matchedNames?.length ? res.matchedNames.join(' / ') : res.name;
  const summary = `${res.count} session${res.count === 1 ? '' : 's'} by ${who} ${res.from}${res.to !== res.from ? '..' + res.to : ''}${res.ambiguous ? ' (several instructors match; say which)' : ''}`;
  return { text: [summary, ...lines].join('\n'), structured: { status: 'success', summary, name: res.name, matchedNames: res.matchedNames || [], from: res.from, to: res.to, count: res.count, sessions: events.map(pick(format)), truncated: truncated || undefined, suggestions: [] } };
}

export function renderNext(res, { format = 'concise' } = {}) {
  if (!res.next) {
    const text = `No future "${res.query}" found ${res.from}..${res.searchedThrough}.`;
    return { text, structured: { status: 'warning', summary: text, query: res.query, from: res.from, searchedThrough: res.searchedThrough, next: null, nextWithSpots: null } };
  }
  const e = res.next; const d = res.detail || {};
  const wl = d.waitlistedUsers != null ? `, waitlist ${d.waitlistedUsers}` : '';
  const win = d.bookableNow === false ? `; booking opens ${d.bookableFrom}` : d.bookableNow ? '; bookable now' : '';
  const cancelBy = d.cancellation?.deadline ? `; free cancel until ${d.cancellation.deadline.slice(0, 16)}` : d.cancellation?.enabled === false ? '; not cancellable' : '';
  const head = `Next "${res.query}": ${e.weekday} ${e.date} ${e.time}-${e.end} · ${e.title} · ${e.studio}${e.instructors.length ? ' · ' + e.instructors.join(', ') : ''} · ${spotsText(e)}${wl}${win}${cancelBy} (${e.id})`;
  const lines = [head];
  if (res.nextWithSpots && !res.sameEvent) { const s = res.nextWithSpots; lines.push(`Next with spots: ${s.weekday} ${s.date} ${s.time} · ${s.title}${s.instructors.length ? ' · ' + s.instructors.join(', ') : ''} · ${spotsText(s)} (${s.id})`); }
  else if (!res.nextWithSpots) lines.push(`No occurrence with spots through ${res.searchedThrough}.`);
  const p = format === 'detailed' ? (x) => x : slimForModel;
  return { text: lines.join('\n'), structured: { status: 'success', summary: head, query: res.query, from: res.from, searchedThrough: res.searchedThrough, next: p(e), nextWithSpots: res.nextWithSpots ? p(res.nextWithSpots) : null, sameEvent: res.sameEvent, waitlistedUsers: d.waitlistedUsers ?? null, bookableNow: d.bookableNow ?? null, bookableFrom: d.bookableFrom ?? null, cancelBy: d.cancellation?.deadline ?? null, myBooking: d.myBooking ?? null } };
}

export function renderEvent(res, { format = 'concise' } = {}) {
  const e = res.event; const lines = [];
  if (e) lines.push(`${e.title} · ${e.weekday} ${e.date} ${e.time}-${e.end} (${e.duration} min) · ${e.studio}${e.instructors.length ? ' · ' + e.instructors.join(', ') : ''} · ${spotsText(e)} (${e.id})`);
  if (e?.description && format === 'detailed') lines.push(e.description);
  if (res.myBooking) lines.push(`My booking: ${res.myBooking.bookingId} ${res.myBooking.status ?? ''}; ${res.myBooking.cancellation?.enabled === false ? 'not cancellable' : `free cancel until ${res.myBooking.cancellation?.deadline ?? '?'}`}${res.myBooking.cancellation?.late ? ` (LATE now, fee ${res.myBooking.cancellation.feeText ?? 'applies'})` : ''}`);
  else lines.push('Not booked.');
  if (res.bookingWindow) lines.push(`Booking: ${res.bookingWindow.bookableNow ? 'open now' : `opens ${res.bookingWindow.bookableFrom}`}${res.bookingWindow.usableOptions === 0 ? ' (no membership option offered yet)' : ''}`);
  const opt = (res.options || [])[0];
  if (opt?.cancellation) lines.push(opt.cancellation.enabled === false ? 'Cancel policy: not cancellable' : `Cancel policy: ${opt.cancellation.windowHours} h before start or ${opt.cancellation.feeText ?? 'a fee'}`);
  if (res.unsignedAgreements?.length) lines.push(`UNSIGNED waiver(s): ${res.unsignedAgreements.join(', ')}`);
  if (res.conflicts?.length) lines.push(`Conflicts: ${res.conflicts.map((c) => c.title || c.id || c).join(', ')}`);
  lines.push(`Waitlist: ${res.waitlistedUsers ?? 0} people${res.waitlistPosition ? `, my position ${res.waitlistPosition}` : ''}`);
  const structured = {
    status: 'success', summary: lines[0] || res.id, id: res.id,
    event: e ? (format === 'detailed' ? e : { ...slimForModel(e), description: e.description }) : null,
    myBooking: res.myBooking, bookingWindow: res.bookingWindow ?? null,
    cancellation: opt?.cancellation ?? res.myBooking?.cancellation ?? null,
    options: (res.options || []).map((o) => ({ title: o.title ?? null, price: o.price ?? 0, unlimited: o.unlimited, disabled: o.disabled, bookableFrom: o.bookableFrom, bookableNow: o.bookableNow })),
    unsignedAgreements: res.unsignedAgreements || [], conflicts: res.conflicts || [], waitlistedUsers: res.waitlistedUsers ?? 0, waitlistPosition: res.waitlistPosition ?? 0,
  };
  return { text: lines.join('\n'), structured };
}

export function renderBookings(res) {
  const pastNote = res.pastCounts && Object.keys(res.pastCounts).length ? ` Past days with bookings: ${Object.entries(res.pastCounts).map(([d, n]) => `${d} (${n})`).join(', ')} (details not available).` : '';
  if (!res.count) { const text = `No upcoming bookings ${res.from}..${res.to}.${pastNote}`; return { text, structured: { status: 'success', summary: text, from: res.from, to: res.to, count: 0, bookings: [], pastCounts: res.pastCounts || {} } }; }
  const lines = res.bookings.map((b) => {
    const c = b.cancellation;
    const tail = c?.enabled === false ? 'not cancellable' : c?.late ? `LATE now (fee ${c.feeText ?? 'applies'})` : c?.deadline ? `free cancel until ${c.deadline.slice(0, 16)}` : '';
    return `${b.date} ${b.time}  ${b.title} · ${b.studio}${b.instructors?.length ? ' · ' + b.instructors.join(', ') : ''} · ${b.status}${b.waitlisted ? ' (waitlist)' : ''} · ${tail}  (booking ${b.bookingId}, event ${b.eventId})`;
  });
  const summary = `${res.count} booking${res.count === 1 ? '' : 's'} ${res.from}..${res.to}${pastNote}`;
  return { text: [summary, ...lines].join('\n'), structured: { status: 'success', summary, from: res.from, to: res.to, count: res.count, bookings: res.bookings.map((b) => ({ bookingId: b.bookingId, eventId: b.eventId, date: b.date, time: b.time, title: b.title, studio: b.studio, instructors: b.instructors, status: b.status, waitlisted: b.waitlisted, canCancel: b.canCancel, cancelBy: b.cancellation?.deadline ?? null, late: b.cancellation?.late ?? null, fee: b.cancellation?.feeText ?? null })), pastCounts: res.pastCounts || {} } };
}

export function renderAction(kind, r) {
  const e = r.event;
  const where = e ? `${e.title} ${e.weekday} ${e.date} ${e.time}` : r.bookingId || '';
  let text;
  if (kind === 'book') text = r.ok ? (r.alreadyBooked ? `Already booked: ${where} (booking ${r.booking?.bookingId}).` : `Booked: ${where} (booking ${r.booking?.bookingId}; ${r.option}; free cancel until ${r.cancelBy ?? r.booking?.cancellation?.deadline ?? '?'}).`) : `Booking NOT made for ${where}: ${r.result?.data?.message || r.serverError || 'unknown reason'}.`;
  else if (kind === 'cancel') text = r.ok ? (r.alreadyCancelled ? `Already not booked: ${where}.` : `Cancelled: ${where} (booking ${r.bookingId}).`) : `Cancel FAILED for ${where}: ${r.serverError || r.result?.data?.message || 'unknown reason'}.`;
  else text = r.ok ? `Waitlist ${kind === 'join' ? 'joined' : 'left'}: ${where}; my position ${r.waitlistPosition ?? '?'}, waitlist size ${r.waitlistedUsers ?? '?'}.` : `Waitlist ${kind} FAILED for ${where}: ${r.result?.data?.message || r.serverError || 'unknown reason'}.`;
  const structured = { status: r.ok ? 'success' : 'error', summary: text, ok: r.ok, via: r.via, alreadyBooked: r.alreadyBooked, alreadyCancelled: r.alreadyCancelled, bookingId: r.booking?.bookingId ?? r.bookingId ?? null, eventId: e?.id ?? null, cancelBy: r.cancelBy ?? r.booking?.cancellation?.deadline ?? null, waitlistPosition: r.waitlistPosition ?? null, event: e ? slimForModel(e) : null, serverError: r.serverError ?? null };
  return { text, structured };
}
