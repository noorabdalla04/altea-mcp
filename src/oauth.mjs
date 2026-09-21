// Single-user OAuth 2.1 authorization server for the remote (Streamable HTTP) transport.
//
// Flow: the MCP client (claude.ai, Claude Code, MCP Inspector, …) registers itself (RFC 7591 dynamic client
// registration), sends the member's browser to /authorize, the member types the passphrase once, the client
// exchanges the code (PKCE S256) for a bearer token and refreshes it silently afterwards. Everything lives in
// ~/.altea/oauth: registered clients, the scrypt-hashed passphrase and the tokens (stored as SHA-256 hashes, so
// the files never contain a usable secret). Restarts keep clients and tokens; `altea remote revoke` empties them.
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './session.mjs';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

export const OAUTH_DIR = process.env.ALTEA_OAUTH_DIR || join(HOME, 'oauth');
/** Hosts a registering client may redirect to (exact or subdomain). Loopback http (any port) is always allowed for local clients. */
export const DEFAULT_REDIRECT_HOSTS = ['claude.ai', 'claude.com'];
export const ACCESS_TTL_S = Number(process.env.ALTEA_ACCESS_TOKEN_TTL_S ?? 7 * 24 * 3600);
export const REFRESH_TTL_S = Number(process.env.ALTEA_REFRESH_TOKEN_TTL_S ?? 180 * 24 * 3600);
const CODE_TTL_MS = 10 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i: typeable on a phone

const now = () => Math.floor(Date.now() / 1000);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Is this redirect URI acceptable for a dynamically registered client? */
export function redirectUriAllowed(uri, hosts = DEFAULT_REDIRECT_HOSTS) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return true;
  if (u.protocol !== 'https:') return false;
  return hosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

export class FileOAuthProvider {
  /**
   * @param {object} o
   * @param {string} [o.dir]             storage directory (default ~/.altea/oauth)
   * @param {string[]} [o.redirectHosts] allowed redirect hosts (default: claude.ai, claude.com + ALTEA_OAUTH_REDIRECT_HOSTS)
   */
  constructor({ dir = OAUTH_DIR, redirectHosts, log = () => {} } = {}) {
    this.dir = dir; this.log = log;
    this.redirectHosts = redirectHosts || [...DEFAULT_REDIRECT_HOSTS, ...(process.env.ALTEA_OAUTH_REDIRECT_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)];
    this.pending = new Map(); // sign-in pages handed out, id → {clientId, params, expiresAt}
    this.codes = new Map();   // authorization codes, code → {clientId, codeChallenge, redirectUri, scopes, resource, expiresAt}
    this.guard = { failures: 0, lockedUntil: 0 };
    this.clientsStore = {
      getClient: (id) => this.#clients()[id],
      registerClient: (info) => {
        if (!info.redirect_uris?.length) throw new InvalidClientMetadataError('redirect_uris is required');
        const bad = info.redirect_uris.find((u) => !redirectUriAllowed(u, this.redirectHosts));
        if (bad) throw new InvalidClientMetadataError(`redirect_uri not allowed: ${bad} (allowed: loopback, ${this.redirectHosts.join(', ')}; extend with ALTEA_OAUTH_REDIRECT_HOSTS)`);
        const client = { ...info, client_id: info.client_id || randomUUID(), client_id_issued_at: info.client_id_issued_at || now() };
        const all = this.#clients(); all[client.client_id] = client; this.#write('clients.json', all);
        this.log(`oauth: registered client "${client.client_name || client.client_id}" (${info.redirect_uris.join(', ')})`);
        return client;
      },
    };
  }

  // ---------- storage ----------
  #path(f) { return join(this.dir, f); }
  #read(f, fallback) { try { return JSON.parse(readFileSync(this.#path(f), 'utf8')); } catch { return fallback; } }
  #write(f, data) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = this.#path(`${f}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.#path(f));
  }
  #clients() { return this.#read('clients.json', {}); }
  #tokens() { return this.#read('tokens.json', {}); }

  // ---------- passphrase ----------
  hasPassphrase() { return !!this.#read('config.json', {}).passphrase; }
  setPassphrase(pass) {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(String(pass).normalize('NFKC').trim(), salt, 32).toString('hex');
    this.#write('config.json', { ...this.#read('config.json', {}), passphrase: { salt, hash, updatedAt: new Date().toISOString() } });
  }
  verifyPassphrase(pass) {
    const p = this.#read('config.json', {}).passphrase;
    if (!p || typeof pass !== 'string') return false;
    const h = scryptSync(pass.normalize('NFKC').trim(), p.salt, 32);
    return timingSafeEqual(h, Buffer.from(p.hash, 'hex'));
  }
  /** Four groups of four unambiguous characters, e.g. x7kq-m3dp-9wvz-b2tn (~79 bits). */
  static generatePassphrase() {
    const group = () => { let s = ''; while (s.length < 4) { const b = randomBytes(1)[0]; if (b < 248) s += ALPHABET[b % ALPHABET.length]; } return s; };
    return [group(), group(), group(), group()].join('-');
  }

  // ---------- OAuthServerProvider ----------
  async authorize(client, params, res) {
    this.#sweep();
    const id = secret();
    this.pending.set(id, { clientId: client.client_id, params, expiresAt: Date.now() + PENDING_TTL_MS });
    res.status(200).type('html').send(this.page({ id, client, params }));
  }

  /** Express handler for the sign-in form (POST /login, urlencoded). */
  loginHandler() {
    return async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const { request: id, passphrase } = req.body || {};
      const p = id && this.pending.get(id);
      if (!p || p.expiresAt < Date.now()) { if (id) this.pending.delete(id); return res.status(400).type('html').send(this.page({ error: 'This sign-in link has expired. Go back to the app and connect again.' })); }
      const client = this.clientsStore.getClient(p.clientId);
      if (Date.now() < this.guard.lockedUntil) return res.status(429).type('html').send(this.page({ id, client, params: p.params, error: 'Too many attempts. Try again in 15 minutes.' }));
      if (!this.verifyPassphrase(passphrase)) {
        this.guard.failures += 1;
        if (this.guard.failures >= MAX_FAILURES) { this.guard.failures = 0; this.guard.lockedUntil = Date.now() + LOCK_MS; this.log('oauth: too many failed passphrase attempts; sign-in locked for 15 min'); }
        return res.status(401).type('html').send(this.page({ id, client, params: p.params, error: 'Wrong passphrase.' }));
      }
      this.guard.failures = 0; this.pending.delete(id);
      const code = secret();
      this.codes.set(code, { clientId: p.clientId, codeChallenge: p.params.codeChallenge, redirectUri: p.params.redirectUri, scopes: p.params.scopes || [], resource: p.params.resource?.href, expiresAt: Date.now() + CODE_TTL_MS });
      const url = new URL(p.params.redirectUri);
      url.searchParams.set('code', code);
      if (p.params.state) url.searchParams.set('state', p.params.state);
      this.log(`oauth: "${client?.client_name || p.clientId}" authorized`);
      res.redirect(302, url.href);
    };
  }

  async challengeForAuthorizationCode(client, code) {
    const c = this.codes.get(code);
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) throw new InvalidGrantError('invalid or expired authorization code');
    return c.codeChallenge;
  }

  async exchangeAuthorizationCode(client, code, _codeVerifier, redirectUri, resource) {
    const c = this.codes.get(code);
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) throw new InvalidGrantError('invalid or expired authorization code');
    if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError('redirect_uri does not match the authorization request');
    this.codes.delete(code);
    return this.#issue(client.client_id, c.scopes, resource?.href || c.resource);
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const t = this.#tokens(); const h = sha(refreshToken); const r = t[h];
    if (!r || r.kind !== 'refresh' || r.clientId !== client.client_id || r.expiresAt < now()) throw new InvalidGrantError('invalid or expired refresh token');
    delete t[h]; delete t[r.pair]; // rotate: the old pair dies with the refresh
    this.#write('tokens.json', t);
    return this.#issue(client.client_id, scopes?.length ? scopes : r.scopes || [], resource?.href || r.resource);
  }

  async verifyAccessToken(token) {
    const a = typeof token === 'string' ? this.#tokens()[sha(token)] : null;
    if (!a || a.kind !== 'access') throw new InvalidTokenError('unknown token');
    if (a.expiresAt < now()) throw new InvalidTokenError('token expired');
    return { token, clientId: a.clientId, scopes: a.scopes || [], expiresAt: a.expiresAt, resource: a.resource ? new URL(a.resource) : undefined };
  }

  async revokeToken(client, { token }) {
    const t = this.#tokens(); const h = sha(token); const r = t[h];
    if (!r || r.clientId !== client.client_id) return;
    delete t[h]; delete t[r.pair];
    this.#write('tokens.json', t);
  }

  /** Sign every client out (they must go through the passphrase page again). Returns how many tokens were dropped. */
  revokeAll() { const n = Object.keys(this.#tokens()).length; this.#write('tokens.json', {}); return n; }

  /** Registered clients (id, name, redirect URIs), for `altea remote status`. */
  clients() { return Object.values(this.#clients()).map((c) => ({ id: c.client_id, name: c.client_name, redirectUris: c.redirect_uris })); }
  /** Live token counts, for `altea remote status`. */
  tokenCounts() { const n = now(); let access = 0, refresh = 0; for (const t of Object.values(this.#tokens())) if (t.expiresAt >= n) { if (t.kind === 'access') access++; else refresh++; } return { access, refresh }; }

  #issue(clientId, scopes, resource) {
    const access = secret(), refresh = secret(), t = this.#tokens(), n = now();
    for (const [k, v] of Object.entries(t)) if (v.expiresAt < n) delete t[k]; // prune expired
    t[sha(access)] = { kind: 'access', clientId, scopes, resource, issuedAt: n, expiresAt: n + ACCESS_TTL_S, pair: sha(refresh) };
    t[sha(refresh)] = { kind: 'refresh', clientId, scopes, resource, issuedAt: n, expiresAt: n + REFRESH_TTL_S, pair: sha(access) };
    this.#write('tokens.json', t);
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, ...(scopes.length ? { scope: scopes.join(' ') } : {}) };
  }

  #sweep() {
    const n = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt < n) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < n) this.codes.delete(k);
  }

  /** The sign-in page (also used for error states). */
  page({ id, client, params, error } = {}) {
    const name = esc(client?.client_name || 'an MCP client');
    let to = ''; try { to = params?.redirectUri ? esc(new URL(params.redirectUri).host) : ''; } catch { /* ignore */ }
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Altea MCP · sign in</title><style>
:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,system-ui,"Segoe UI",Roboto,sans-serif;background:#f4f4f5;color:#18181b}
@media(prefers-color-scheme:dark){body{background:#18181b;color:#fafafa}main{background:#27272a}}
main{width:min(92vw,380px);box-sizing:border-box;padding:28px;border-radius:16px;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.12)}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 18px;font-size:14px;line-height:1.45;opacity:.85}
input{width:100%;box-sizing:border-box;font-size:18px;padding:12px;border:1px solid #a1a1aa;border-radius:10px;background:Field;color:FieldText;letter-spacing:.04em}
button{width:100%;margin-top:14px;font-size:16px;padding:12px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-weight:600}
.err{color:#dc2626;font-size:14px;margin:0 0 12px}</style></head><body><main><h1>Altea MCP</h1>
${id ? `<p>Connect <b>${name}</b>${to ? ` (${to})` : ''} to your Altea booking assistant. Enter the passphrase set with <code>altea remote passphrase</code>.</p>` : ''}
${error ? `<p class="err">${esc(error)}</p>` : ''}
${id ? `<form method="post" action="/login"><input type="hidden" name="request" value="${esc(id)}"><input type="password" name="passphrase" placeholder="passphrase" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" autofocus required><button type="submit">Connect</button></form>` : ''}
</main></body></html>`;
  }
}
