// Token-lean renderings of client results for the model. `concise` (default) = short text lines a model reads
// well + a minimal structured list; `detailed` = full objects (ids, urls, instructor ids) for chained calls.

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
export const spotsText = (e) => (e.myStatus ? `BOOKED` : e.waitlisted ? 'WAITLISTED' : e.full ? 'FULL' : `${e.spotsLeft} left`);

export function eventLine(e, { group = false } = {}) {
  const who = e.instructors?.length ? ` · ${e.instructors.join(', ')}` : '';
  const g = group && e.group && e.group !== 'Boutique Fitness' ? ` [${e.group}]` : '';
  return `${e.time}-${e.end}  ${e.title} · ${e.studio}${who} · ${spotsText(e)}${g}  (${e.id})`;
}

/** Minimal event object for structured output. */
export function slimForModel(e) {
  return { id: e.id, date: e.date, time: e.time, end: e.end, title: e.title, studio: e.studio, instructors: e.instructors, spotsLeft: e.spotsLeft, full: e.full, myStatus: e.myStatus, waitlisted: e.waitlisted, group: e.group };
}

/** Apply a hard cap per day list and report truncation. */
export function capEvents(events, limit) {
  if (!limit || events.length <= limit) return { events, truncated: 0 };
  return { events: events.slice(0, limit), truncated: events.length - limit };
}

export function renderSchedule(res, { format = 'concise', limit = 60 } = {}) {
  const lines = [];
  const days = [];
  let truncatedTotal = 0;
  for (const d of res.days) {
    const { events, truncated } = capEvents(d.events, limit);
    truncatedTotal += truncated;
    lines.push(`${d.weekday} ${d.date} · ${res.groups.length > 1 ? 'all groups' : res.groups[0]} · ${d.events.length} events${d.errors ? ` · errors: ${d.errors.join('; ')}` : ''}`);
    for (const e of events) lines.push('  ' + eventLine(e, { group: res.groups.length > 1 }));
    if (truncated) lines.push(`  … ${truncated} more (narrow with instructor/type/studio/after/before/at, or raise limit)`);
    days.push({ date: d.date, weekday: d.weekday, count: d.events.length, events: (format === 'detailed' ? events : events.map(slimForModel)), truncated: truncated || undefined, errors: d.errors });
  }
  const summary = `${res.count} events ${res.from}${res.to !== res.from ? '..' + res.to : ''}${res.filters ? ' (filtered)' : ''}${truncatedTotal ? `, ${truncatedTotal} not shown` : ''}`;
  return { text: [summary, ...lines].join('\n'), structured: { status: res.count ? 'success' : 'warning', summary, from: res.from, to: res.to, groups: res.groups, count: res.count, days } };
}

export function renderFind(res, opts) {
  const r = renderSchedule(res, opts);
  return { text: r.text, structured: { ...r.structured, events: res.events.map(opts?.format === 'detailed' ? (e) => e : slimForModel).slice(0, opts?.limit || 60) } };
}

export function renderInstructor(res, { format = 'concise', limit = 60 } = {}) {
  if (!res.count) {
    const sugg = res.suggestions.length ? ` Did you mean: ${res.suggestions.join(', ')}?` : '';
    const text = `No sessions by "${res.name}" ${res.from}${res.to !== res.from ? '..' + res.to : ''} across ${res.groups.length} groups (${res.instructorsSeen} instructors seen).${sugg}`;
    return { text, structured: { status: 'warning', summary: text, name: res.name, from: res.from, to: res.to, count: 0, sessions: [], suggestions: res.suggestions } };
  }
  const { events, truncated } = capEvents(res.sessions, limit);
  const lines = [];
  let last = null;
  for (const e of events) { if (e.date !== last) { lines.push(`${e.weekday} ${e.date}`); last = e.date; } lines.push('  ' + eventLine(e, { group: true })); }
  if (truncated) lines.push(`… ${truncated} more`);
  const summary = `${res.count} session${res.count === 1 ? '' : 's'} by ${res.sessions[0].instructors.find((n) => n.toLowerCase().includes(res.name.toLowerCase())) || res.name} ${res.from}${res.to !== res.from ? '..' + res.to : ''}`;
  return { text: [summary, ...lines].join('\n'), structured: { status: 'success', summary, name: res.name, from: res.from, to: res.to, count: res.count, sessions: events.map(format === 'detailed' ? (e) => e : slimForModel), truncated: truncated || undefined, suggestions: [] } };
}

export function renderNext(res, { format = 'concise' } = {}) {
  if (!res.next) {
    const text = `No future "${res.query}" found ${res.from}..${res.searchedThrough}.`;
    return { text, structured: { status: 'warning', summary: text, query: res.query, from: res.from, searchedThrough: res.searchedThrough, next: null, nextWithSpots: null } };
  }
  const e = res.next; const d = res.detail || {};
  const wl = d.waitlistedUsers != null ? `, waitlist ${d.waitlistedUsers}` : '';
  const win = d.bookableNow === false ? `; booking opens ${d.bookableFrom}` : d.bookableNow ? '; bookable now' : '';
  const cancelBy = d.cancellation?.deadline ? `; free cancel until ${d.cancellation.deadline.slice(0, 16)}` : '';
  const head = `Next "${res.query}": ${e.weekday} ${e.date} ${e.time}-${e.end} · ${e.title} · ${e.studio}${e.instructors.length ? ' · ' + e.instructors.join(', ') : ''} · ${spotsText(e)}${wl}${win}${cancelBy} (${e.id})`;
  const lines = [head];
  if (res.nextWithSpots && !res.sameEvent) { const s = res.nextWithSpots; lines.push(`Next with spots: ${s.weekday} ${s.date} ${s.time} · ${s.title}${s.instructors.length ? ' · ' + s.instructors.join(', ') : ''} · ${spotsText(s)} (${s.id})`); }
  else if (!res.nextWithSpots) lines.push(`No occurrence with spots through ${res.searchedThrough}.`);
  const pick = format === 'detailed' ? (x) => x : slimForModel;
  return { text: lines.join('\n'), structured: { status: 'success', summary: head, query: res.query, from: res.from, searchedThrough: res.searchedThrough, next: pick(e), nextWithSpots: res.nextWithSpots ? pick(res.nextWithSpots) : null, sameEvent: res.sameEvent, waitlistedUsers: d.waitlistedUsers ?? null, bookableNow: d.bookableNow ?? null, bookableFrom: d.bookableFrom ?? null, cancelBy: d.cancellation?.deadline ?? null, myBooking: d.myBooking ?? null } };
}

export function renderEvent(res, { format = 'concise' } = {}) {
  const e = res.event;
  const lines = [];
  if (e) lines.push(`${e.title} · ${e.weekday} ${e.date} ${e.time}-${e.end} (${e.duration} min) · ${e.studio}${e.instructors.length ? ' · ' + e.instructors.join(', ') : ''} · ${spotsText(e)} (${e.id})`);
  if (e?.description && format === 'detailed') lines.push(e.description);
  if (res.myBooking) lines.push(`My booking: ${res.myBooking.bookingId} ${res.myBooking.status}; free cancel until ${res.myBooking.cancellation?.deadline ?? '?'}${res.myBooking.cancellation?.late ? ` (LATE now, fee ${res.myBooking.cancellation.feeText ?? 'applies'})` : ''}`);
  else lines.push('Not booked.');
  if (res.bookingWindow) lines.push(`Booking: ${res.bookingWindow.bookableNow ? 'open now' : `opens ${res.bookingWindow.bookableFrom}`} (48 h rule${res.bookingWindow.usableOptions === 0 ? ', no membership option offered yet' : ''})`);
  const opt = (res.options || [])[0];
  if (opt?.cancellation) lines.push(`Cancel policy: ${opt.cancellation.windowHours} h before start or ${opt.cancellation.feeText ?? 'a fee'}`);
  if (res.unsignedAgreements?.length) lines.push(`UNSIGNED waiver(s): ${res.unsignedAgreements.join(', ')}`);
  if (res.conflicts?.length) lines.push(`Conflicts: ${res.conflicts.map((c) => c.title || c.id || c).join(', ')}`);
  lines.push(`Waitlist: ${res.waitlistedUsers ?? 0} people${res.waitlistPosition ? `, my position ${res.waitlistPosition}` : ''}`);
  const structured = {
    status: 'success', summary: lines[0] || res.id, id: res.id,
    event: e ? (format === 'detailed' ? e : { ...slimForModel(e), description: e.description }) : null,
    myBooking: res.myBooking, bookingWindow: res.bookingWindow ?? null,
    cancellation: opt?.cancellation ?? res.myBooking?.cancellation ?? null,
    options: (res.options || []).map((o) => ({ title: o.title, unlimited: o.unlimited, disabled: o.disabled, bookableFrom: o.bookableFrom, bookableNow: o.bookableNow })),
    unsignedAgreements: res.unsignedAgreements || [], conflicts: res.conflicts || [], waitlistedUsers: res.waitlistedUsers ?? 0, waitlistPosition: res.waitlistPosition ?? 0,
  };
  return { text: lines.join('\n'), structured };
}

export function renderBookings(res) {
  if (!res.count) { const text = `No bookings ${res.from}..${res.to}.`; return { text, structured: { status: 'success', summary: text, from: res.from, to: res.to, count: 0, bookings: [] } }; }
  const lines = res.bookings.map((b) => {
    const c = b.cancellation;
    const tail = c?.late ? `LATE now (fee ${c.feeText ?? 'applies'})` : c?.deadline ? `free cancel until ${c.deadline.slice(0, 16)}` : '';
    return `${b.date} ${b.time}  ${b.title} · ${b.studio}${b.instructors?.length ? ' · ' + b.instructors.join(', ') : ''} · ${b.status}${b.waitlisted ? ' (waitlist)' : ''} · ${tail}  (booking ${b.bookingId}, event ${b.eventId})`;
  });
  const summary = `${res.count} booking${res.count === 1 ? '' : 's'} ${res.from}..${res.to}`;
  return { text: [summary, ...lines].join('\n'), structured: { status: 'success', summary, from: res.from, to: res.to, count: res.count, bookings: res.bookings.map((b) => ({ bookingId: b.bookingId, eventId: b.eventId, date: b.date, time: b.time, title: b.title, studio: b.studio, instructors: b.instructors, status: b.status, waitlisted: b.waitlisted, canCancel: b.canCancel, cancelBy: b.cancellation?.deadline ?? null, late: b.cancellation?.late ?? null, fee: b.cancellation?.feeText ?? null })) } };
}

export function renderAction(kind, r) {
  const e = r.event;
  const where = e ? `${e.title} ${e.weekday} ${e.date} ${e.time}` : r.bookingId || '';
  let text;
  if (kind === 'book') text = r.ok ? (r.alreadyBooked ? `Already booked: ${where} (booking ${r.booking?.bookingId}).` : `Booked: ${where} (booking ${r.booking?.bookingId}; ${r.option}; free cancel until ${r.cancelBy ?? r.booking?.cancellation?.deadline ?? '?'}).`) : `Booking NOT made for ${where}: ${r.result?.data?.message || r.serverError || 'unknown reason'}.`;
  else if (kind === 'cancel') text = r.ok ? (r.alreadyCancelled ? `Already not booked: ${where}.` : `Cancelled: ${where} (booking ${r.bookingId}).`) : `Cancel FAILED for ${where}: ${r.serverError || r.result?.data?.message || 'unknown reason'}.`;
  else text = r.ok ? `Waitlist ${kind === 'join' ? 'joined' : 'left'}: ${where}; my position ${r.waitlistPosition ?? '?'}, waitlist size ${r.waitlistedUsers ?? '?'}.` : `Waitlist ${kind} FAILED for ${where}: ${r.serverError || 'unknown reason'}.`;
  const structured = { status: r.ok ? 'success' : 'error', summary: text, ok: r.ok, via: r.via, alreadyBooked: r.alreadyBooked, alreadyCancelled: r.alreadyCancelled, bookingId: r.booking?.bookingId ?? r.bookingId ?? null, eventId: e?.id ?? null, cancelBy: r.cancelBy ?? r.booking?.cancellation?.deadline ?? null, waitlistPosition: r.waitlistPosition ?? null, event: e ? slimForModel(e) : null, serverError: r.serverError ?? null };
  return { text, structured };
}
