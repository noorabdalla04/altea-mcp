// Session management: cookie jar + fast Node fetch, and a persistent Chrome
// profile (Playwright) for the two things fetch cannot do: the interactive
// sign-in, and POSTs to /booking/* which Vercel BotID (Kasada) guards with an
// `x-is-human` proof that only the in-page SDK can mint.
//
// Fast path (reads, cancel, waitlist-leave posted to "/"): Node fetch with the
// cookie header, ~150-400 ms, no Chrome process.
// Slow path (book, waitlist-join on the event page): a real page in the
// persistent profile, `page.evaluate(fetch)` so the SDK wrapper adds the proof.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ORIGIN = 'https://myaltea.app';
export const HOME = process.env.ALTEA_HOME || join(homedir(), '.altea');
export const PROFILE_DIR = join(HOME, 'profile');
export const COOKIES_FILE = join(HOME, 'cookies.json');
export const ACTIONS_FILE = join(HOME, 'actions.json');
export const META_FILE = join(HOME, 'meta.json');
export const TZ = 'America/Toronto';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export class NotSignedIn extends Error {
  constructor(msg = 'Not signed in to myaltea.app. Run `altea login` (opens a Chrome window; sign in once; cookies persist).') {
    super(msg); this.name = 'NotSignedIn';
  }
}

// ---------- cookie jar ----------

export async function loadCookies() {
  try { return JSON.parse(await readFile(COOKIES_FILE, 'utf8')); } catch { return []; }
}

export async function saveCookies(cookies) {
  await mkdir(HOME, { recursive: true });
  await writeFile(COOKIES_FILE, JSON.stringify(cookies, null, 2), { mode: 0o600 });
}

function cookieMatches(c, host) {
  const d = (c.domain || '').replace(/^\./, '');
  return host === d || host.endsWith('.' + d);
}

export function cookieHeader(cookies, host = 'myaltea.app') {
  const now = Date.now() / 1000;
  const parts = [];
  const seen = new Set();
  for (const c of cookies) {
    if (!cookieMatches(c, host)) continue;
    if (c.expires && c.expires > 0 && c.expires < now) continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    parts.push(`${c.name}=${c.value}`);
  }
  if (!seen.has('tz')) parts.push(`tz=${encodeURIComponent(TZ)}`);
  return parts.join('; ');
}

/** Merge Set-Cookie headers from a response into the jar (auth cookie rotation). */
function absorbSetCookies(jar, res) {
  const setc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  let changed = false;
  for (const line of setc) {
    const [pair, ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const a = Object.fromEntries(attrs.map((s) => { const [k, ...v] = s.trim().split('='); return [k.toLowerCase(), v.join('=')]; }));
    const domain = (a.domain || 'myaltea.app').replace(/^\./, '');
    let expires = -1;
    if (a['max-age']) expires = Date.now() / 1000 + Number(a['max-age']);
    else if (a.expires) expires = Date.parse(a.expires) / 1000;
    const idx = jar.findIndex((c) => c.name === name && (c.domain || '').replace(/^\./, '') === domain);
    const cookie = { name, value, domain: a.domain ? a.domain : domain, path: a.path || '/', expires, httpOnly: 'httponly' in a, secure: 'secure' in a, sameSite: 'Lax' };
    if (expires > 0 && expires < Date.now() / 1000) { if (idx >= 0) jar.splice(idx, 1); }
    else if (idx >= 0) jar[idx] = cookie; else jar.push(cookie);
    changed = true;
  }
  return changed;
}

// ---------- fast HTTP session ----------

export class HttpSession {
  constructor(cookies) { this.cookies = cookies; this.dirty = false; }

  static async load() { return new HttpSession(await loadCookies()); }

  async persist() { if (this.dirty) { await saveCookies(this.cookies); this.dirty = false; } }

  headers(extra = {}) {
    return { 'user-agent': UA, cookie: cookieHeader(this.cookies), ...extra };
  }

  /** GET an RSC payload for a path. Throws NotSignedIn when the app served the auth shell instead. */
  async rsc(path) {
    const res = await fetch(ORIGIN + path, { headers: this.headers({ rsc: '1', accept: '*/*' }), redirect: 'manual' });
    if (absorbSetCookies(this.cookies, res)) this.dirty = true;
    const text = await res.text();
    if (res.status >= 300 && res.status < 400) throw new NotSignedIn(`redirected to ${res.headers.get('location')}`);
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    if (looksSignedOut(text)) throw new NotSignedIn();
    return text;
  }

  /** GET page HTML (for chunk discovery). */
  async html(url) {
    const res = await fetch(url, { headers: this.headers({ accept: 'text/html' }) });
    return res.text();
  }

  /**
   * Invoke a server action from Node (only works for routes outside /booking/*,
   * i.e. not guarded by the bot challenge). Returns raw x-component text + headers.
   */
  async action(pagePath, actionId, args) {
    const res = await fetch(ORIGIN + pagePath, {
      method: 'POST',
      headers: this.headers({ 'next-action': actionId, accept: 'text/x-component', 'content-type': 'text/plain;charset=UTF-8' }),
      body: JSON.stringify(args),
      redirect: 'manual',
    });
    if (absorbSetCookies(this.cookies, res)) this.dirty = true;
    const text = await res.text();
    return { status: res.status, text, revalidated: res.headers.get('x-action-revalidated') === '1', contentType: res.headers.get('content-type') || '' };
  }
}

/**
 * Signed-in detection. The auth shell is served with HTTP 200 on every path, so
 * we look for data that only an authenticated render carries. The unauthenticated
 * payload instead carries the auth.myaltea.app redirect target.
 */
export function looksSignedOut(text) {
  if (!text) return true;
  if (/"currentUser"|"eventsPromise"|"bookingsPromise"|"bookingContextPromise"/.test(text)) return false;
  return true;
}

// ---------- Playwright (persistent Chrome profile) ----------

let _pw = null;
async function pw() { if (!_pw) _pw = await import('playwright-core'); return _pw; }

/**
 * Open the persistent profile. Falls back to a throwaway context seeded from the
 * cookie jar when the profile is locked by another process (MCP + CLI at once).
 */
export async function openBrowser({ headless = true, log = () => {} } = {}) {
  const { chromium } = await pw();
  await mkdir(PROFILE_DIR, { recursive: true });
  const common = {
    channel: 'chrome',
    headless,
    viewport: { width: 1100, height: 900 },
    locale: 'en-CA',
    timezoneId: TZ,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  try {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, common);
    log(`chrome: persistent profile (${headless ? 'headless' : 'headed'})`);
    return { context, persistent: true, close: () => context.close() };
  } catch (e) {
    if (!/ProcessSingleton|already running|profile.*in use|Target page, context or browser has been closed|Failed to launch/i.test(String(e))) throw e;
    log('chrome: profile locked, using cookie-seeded temporary context');
    const browser = await chromium.launch({ channel: 'chrome', headless, args: common.args, ignoreDefaultArgs: common.ignoreDefaultArgs });
    const context = await browser.newContext({ viewport: common.viewport, locale: common.locale, timezoneId: TZ, userAgent: undefined });
    const cookies = await loadCookies();
    if (cookies.length) await context.addCookies(cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || '/', expires: c.expires ?? -1, httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || 'Lax' })));
    return { context, persistent: false, close: () => browser.close() };
  }
}

/** Export the profile's cookies for the fast path. */
export async function exportCookies(context) {
  const cookies = await context.cookies([ORIGIN, 'https://auth.myaltea.app']);
  await saveCookies(cookies);
  return cookies;
}

/** Headed sign-in. Resolves once the app renders an authenticated page. */
export async function login({ timeoutMs = 30 * 60_000, log = console.error } = {}) {
  const { context, close } = await openBrowser({ headless: false, log });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(ORIGIN + '/booking', { waitUntil: 'domcontentloaded' });
  await page.bringToFront().catch(() => {});
  log(`Sign in to Altea in the Chrome window that just opened (profile ${PROFILE_DIR}). Waiting up to ${Math.round(timeoutMs / 60000)} min…`);
  const deadline = Date.now() + timeoutMs;
  let tick = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if (++tick % 40 === 0) log(`still waiting… (${Math.round((deadline - Date.now()) / 60000)} min left, url ${page.url().slice(0, 60)})`);
    const url = page.url();
    if (url.startsWith(ORIGIN)) {
      const ok = await page.evaluate(async () => {
        try { const r = await fetch('/booking', { headers: { RSC: '1' } }); const t = await r.text(); return t.includes('"currentUser"') || t.includes('"eventsPromise"'); } catch { return false; }
      }).catch(() => false);
      if (ok) {
        const cookies = await exportCookies(context);
        log(`Signed in. Saved ${cookies.length} cookies to ${COOKIES_FILE}.`);
        await close();
        return cookies;
      }
    }
  }
  await close();
  throw new Error('login timed out');
}

/**
 * Run a server action inside a real page (needed for /booking/* which the bot
 * challenge guards). The page's fetch wrapper adds x-is-human automatically.
 */
export async function inPageAction(page, pagePath, actionId, args) {
  const target = ORIGIN + pagePath;
  if (!page.url().startsWith(target)) await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.KPSDK !== 'undefined' || document.readyState === 'complete', null, { timeout: 15_000 }).catch(() => {});
  return page.evaluate(async ({ pagePath, actionId, body }) => {
    const res = await fetch(pagePath, {
      method: 'POST',
      headers: { 'next-action': actionId, accept: 'text/x-component', 'content-type': 'text/plain;charset=UTF-8' },
      body,
    });
    return { status: res.status, text: await res.text(), revalidated: res.headers.get('x-action-revalidated') === '1', contentType: res.headers.get('content-type') || '' };
  }, { pagePath, actionId, body: JSON.stringify(args) });
}
