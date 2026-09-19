// Build-bound discovery of Next.js server-action ids.
//
// myaltea.app mutations are server actions: POST <page url> with header
// `Next-Action: <40-hex id>` and a JSON-array body of arguments. The ids are
// content hashes that change on every deploy, so we never hard-code them: we
// read the current page HTML for its chunk list, download the chunks (public,
// immutable, cacheable) and regex the `createServerReference("<id>", …, "<name>")`
// registrations. The cancel action is exported as a module `default`, so we
// name it by the chunk it lives in (the one with the "Cancel Booking" dialog).

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const ORIGIN = 'https://myaltea.app';
const CHUNK_RE = /\/_next\/static\/chunks\/[^"'\s<>]+\.js/g;
const REF_RE = /createServerReference\)\("([0-9a-f]{40,})",[^,]+,void 0,[^,]+,"([^"]+)"\)/g;

// Names we know how to call, and what we call them internally.
export const KNOWN_ACTIONS = {
  confirmBookingAction: 'book',
  joinWaitlistAction: 'waitlistJoin',
  leaveWaitlistAction: 'waitlistLeave',
  inviteGuestAction: 'inviteGuest',
  setHomeCommunityIdAction: 'setHomeCommunity',
  refreshAlertsAction: 'refreshAlerts',
  cancelBookingAction: 'cancel', // synthesized name, see below
};

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

/**
 * @param {(url:string)=>Promise<string>} fetchHtml  authenticated HTML fetcher (page context)
 * @param {object} opts
 * @param {string[]} opts.pages   page paths whose HTML lists the chunks (include an event page!)
 * @param {string}   opts.cacheFile
 * @param {boolean}  [opts.force]
 */
export async function discoverActions(fetchHtml, { pages, cacheFile, force = false, log = () => {} }) {
  const htmls = await Promise.all(pages.map((p) => fetchHtml(ORIGIN + p).catch(() => '')));
  const chunkPaths = [...new Set(htmls.flatMap((h) => h.match(CHUNK_RE) || []))].sort();
  if (chunkPaths.length === 0) throw new Error('discoverActions: no chunk urls found in page html (not signed in? offline?)');
  const key = createHash('sha1').update(chunkPaths.join('\n')).digest('hex').slice(0, 16);

  if (!force) {
    try {
      const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
      if (cached.key === key && cached.actions?.confirmBookingAction) { log(`actions: cache hit ${key}`); return cached; }
    } catch { /* no cache */ }
  }

  log(`actions: discovering from ${chunkPaths.length} chunks`);
  const texts = await mapLimit(chunkPaths, 8, async (p) => {
    const r = await fetch(ORIGIN + p);
    return r.ok ? r.text() : '';
  });

  const actions = {};
  const defaults = [];
  chunkPaths.forEach((p, idx) => {
    const s = texts[idx];
    for (const m of s.matchAll(REF_RE)) {
      const [, id, name] = m;
      if (name === 'default') defaults.push({ id, chunk: p, cancelHints: /Cancel Booking/.test(s) && /bookingId/.test(s) });
      else actions[name] = id;
    }
  });
  const cancel = defaults.find((d) => d.cancelHints);
  if (cancel) actions.cancelBookingAction = cancel.id;

  const out = { key, discoveredAt: new Date().toISOString(), chunks: chunkPaths.length, actions, defaults };
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify(out, null, 2));
  return out;
}
