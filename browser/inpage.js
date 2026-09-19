// altea in-page helper — paste into the Claude browser pane (javascript_tool) on any
// authenticated myaltea.app tab. Installs window.A with read helpers that use the
// page's own cookies. Fallback for when the MCP/CLI cookie jar is stale.
//   await A.schedule('2026-09-21', 'Boutique Fitness')      -> slim events
//   await A.event('evt_…')                                  -> {event, myBooking, options, …}
//   await A.bookings('2026-09-20')                          -> bookings on that day
//   await A.days('2026-09-21', 7, 'Pickleball')             -> multi-day, parallel
(() => {
  let COMMUNITY = null;
  const community = async () => { if (COMMUNITY) return COMMUNITY; const r = await fetch('/booking', { headers: { RSC: '1' } }); COMMUNITY = ((await r.text()).match(/"communityId":"(com_[A-Za-z0-9]+)","eventTypesPromise"/) || [])[1] || null; return COMMUNITY; };
  function parseRSC(text) {
    const enc = new TextEncoder(), dec = new TextDecoder(); const b = enc.encode(text); const rows = {}; let i = 0; const n = b.length;
    const readUntil = (ch) => { const s = i; while (i < n && b[i] !== ch) i++; const o = dec.decode(b.subarray(s, i)); i++; return o; };
    while (i < n) { const id = readUntil(58); if (i >= n) break; if (b[i] === 84) { i++; const len = parseInt(readUntil(44), 16); rows[id] = { type: 'T', text: dec.decode(b.subarray(i, i + len)) }; i += len; if (b[i] === 10) i++; } else { const line = readUntil(10); const r = { type: 'J', raw: line }; try { r.json = JSON.parse(line); } catch (e) {} rows[id] = r; } }
    return rows;
  }
  const rsc = async (path) => { const r = await fetch(path, { headers: { RSC: '1' } }); return parseRSC(await r.text()); };
  const find = (rows, pred) => { for (const [id, r] of Object.entries(rows)) { if (r.json !== undefined) { try { if (pred(r.json, id)) return r.json; } catch (e) {} } } return null; };
  const local = (iso) => { const d = new Date(iso); const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` }; };
  const slim = (e) => { const s = local(e.startDate); return { id: e.id, title: (e.title || '').trim(), date: s.date, time: s.time, duration: e.duration, studio: e.calendar, instructors: Object.values(e.resources || {}).map((r) => r.name), types: Object.values(e.tags || {}).map((t) => t.label), spotsLeft: e.spotsLeft, full: (e.spotsLeft ?? 1) <= 0, myStatus: e.userBookingStatus, waitlisted: !!e.waitlisted, description: (e.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }; };
  const ddmmyyyy = (ymd) => { const [y, m, d] = ymd.split('-'); return `${d}-${m}-${y}`; };
  window.A = {
    parseRSC, rsc,
    async schedule(ymd, group = 'Boutique Fitness', communityId) {
      const rows = await rsc(`/booking?date=${ddmmyyyy(ymd)}&calendarGroup=${encodeURIComponent(group)}&communityId=${communityId || await community()}`);
      const arr = find(rows, (j) => Array.isArray(j) && j[0] && String(j[0].id || '').startsWith('evt_')) || [];
      return arr.map(slim).sort((a, b) => a.time.localeCompare(b.time));
    },
    async days(ymd, n = 7, group, communityId) {
      const [y, m, d] = ymd.split('-').map(Number);
      const dates = Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
      const all = await Promise.all(dates.map((dt) => this.schedule(dt, group, communityId)));
      return dates.map((dt, i) => ({ date: dt, events: all[i] }));
    },
    async event(id) {
      const rows = await rsc(`/booking/${id}`);
      const ctx = find(rows, (j) => j && typeof j === 'object' && !Array.isArray(j) && 'activeBookings' in j);
      const ev = find(rows, (j) => j && typeof j === 'object' && !Array.isArray(j) && j.id === id && 'startDate' in j);
      const me = ctx?.context?.currentUser || {};
      const pair = (ctx?.activeBookings || []).find((p) => p?.[1]?.id?.startsWith('bkg_'));
      return { event: ev ? slim(ev) : null, myBooking: pair ? { bookingId: pair[1].id, status: pair[1].status, cancellation: pair[1].perk?.cancellation } : null, options: (me.perks || []).map((p) => ({ perkId: p.perkId, userPerkId: p.userPerkId, title: p.title, unlimited: p.unlimited, bookingWindowMin: p.bookingWindow, cancellation: p.cancellation?.shortText })), paymentMethods: (me.paymentMethods || []).map((p) => ({ id: p.id, label: p.label, default: !!p.default })), unsignedAgreements: (me.unsignedAgreements || []).length, conflicts: me.eventConflicts || [], waitlisted: (ctx?.waitlistedUsers || []).length, userId: me.id };
    },
    async bookings(ymd) {
      const rows = await rsc(`/?date=${ymd}`);
      const counts = find(rows, (j) => Array.isArray(j) && j[0] && Array.isArray(j[0]) && /^\d{4}-\d{2}-\d{2}$/.test(j[0][0])) || [];
      const list = find(rows, (j) => Array.isArray(j) && j[0] && typeof j[0] === 'object' && 'canCancel' in j[0]) || [];
      return { datesWithBookings: counts.map(([d, c]) => ({ date: d, ...c })), today: list.map((b) => ({ canCancel: b.canCancel, bookingId: (b.booking || b).id, status: (b.booking || b).status, event: b.event ? slim(b.event) : null })) };
    },
  };
  return 'window.A installed: schedule(ymd, group), days(ymd, n, group), event(id), bookings(ymd)';
})();
