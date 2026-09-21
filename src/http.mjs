// Remote transport: the same MCP server over Streamable HTTP, behind OAuth, for claude.ai / the Claude apps /
// Claude Code on any device. Stateless: every POST /mcp gets a fresh McpServer bound to one shared Altea client
// (one cookie jar, one Chrome, one mutex), so restarts never strand a session and nothing accumulates.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createAlteaServer } from './server.mjs';
import { Mutex, withTimeout } from './errors.mjs';
import { Altea } from './client.mjs';

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {object} o
 * @param {string} o.publicUrl        the URL clients use (https, or http://localhost for tests); issuer + resource base
 * @param {object} o.provider         FileOAuthProvider (or any OAuthServerProvider)
 * @param {() => object} [o.makeClient] Altea client factory (tests inject a stub); one instance is shared by all requests
 * @param {boolean} [o.trustProxy]    true when a reverse proxy (Tailscale Funnel, Cloudflare Tunnel) sits in front
 */
export function createHttpApp({ publicUrl, provider, makeClient, log = (m) => process.stderr.write(`[altea-http] ${m}\n`), readTimeoutMs = 60_000, actionTimeoutMs = 150_000, idleMs = 10 * 60_000, keepAliveMs = 0, trustProxy = true } = {}) {
  if (!publicUrl) throw new Error('publicUrl is required (ALTEA_PUBLIC_URL)');
  if (!provider) throw new Error('provider is required');
  const base = new URL(publicUrl);
  if (base.pathname !== '/') throw new Error('publicUrl must be an origin without a path, e.g. https://host.example:8443');
  const mcpUrl = new URL('/mcp', base);

  // ---- one shared backend ----
  const factory = makeClient || (() => new Altea({ log }));
  let client = null; let lastUse = Date.now();
  const shared = () => { lastUse = Date.now(); if (!client) client = factory(); return client; };
  const mutex = new Mutex();
  const idle = setInterval(async () => { if (client?.browser && Date.now() - lastUse > idleMs) { log('idle: closing chrome'); await client.close().catch(() => {}); } }, 60_000);
  idle.unref();
  // keep-alive: the app re-issues the session cookie on every request (a sliding window), so a periodic cheap read keeps
  // a served session signed in indefinitely; without traffic it would lapse after the cookie's lifetime.
  const keepAlive = async () => {
    try {
      const c = shared(); if (c.init) await c.init();
      const s = await withTimeout(c.status(), readTimeoutMs, 'keep-alive');
      if (c.http?.persist) await c.http.persist();
      log(`keep-alive: ${s.signedIn ? `signed in, session cookie expires ${s.sessionExpiresAt}` : `NOT signed in (${s.error}); push a fresh session`}`);
      return s;
    } catch (e) { log(`keep-alive failed: ${e?.message || e}`); return null; }
  };
  const alive = keepAliveMs > 0 ? setInterval(keepAlive, keepAliveMs) : null;
  alive?.unref();

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  // access log (health checks excluded): enough to tell whether a client ever reached the server and how it fared
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next();
    const t0 = Date.now();
    res.on('finish', () => log(`${req.method} ${req.path} → ${res.statusCode} ${Date.now() - t0}ms ip=${req.ip} ua="${(req.get('user-agent') || '').slice(0, 60)}"`));
    next();
  });

  app.get('/healthz', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, name: pkg.name, version: pkg.version, mcp: mcpUrl.href, time: new Date().toISOString() }); });
  app.get('/', (req, res) => res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Altea MCP</title><style>body{font-family:-apple-system,system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color-scheme:light dark}code{background:rgba(127,127,127,.15);padding:.1em .3em;border-radius:4px}</style></head><body><h1>Altea MCP ${esc(pkg.version)}</h1><p>This is a remote MCP server for the Altea Active booking app. Its endpoint is <code>${esc(mcpUrl.href)}</code>.</p><p>Add it as a custom connector in claude.ai (Settings → Connectors → Add custom connector) or in Claude Code with <code>claude mcp add --transport http altea ${esc(mcpUrl.href)}</code>. You will be asked for the passphrase once per client.</p></body></html>`));

  // sign-in form (must precede the auth router, which owns /authorize)
  app.post('/login', express.urlencoded({ extended: false }), provider.loginHandler());

  // OAuth: metadata, dynamic registration, /authorize, /token, /revoke
  app.use(mcpAuthRouter({ provider, issuerUrl: base, resourceServerUrl: mcpUrl, scopesSupported: ['altea'], resourceName: 'Altea MCP', clientRegistrationOptions: { clientSecretExpirySeconds: 0 } })); // secrets never expire: a phone should not have to reconnect monthly
  // some clients look for protected-resource metadata at the root path too
  app.get('/.well-known/oauth-protected-resource', (req, res) => res.json({ resource: mcpUrl.href, authorization_servers: [base.href], scopes_supported: ['altea'], resource_name: 'Altea MCP' }));

  const auth = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  app.post('/mcp', auth, express.json({ limit: '1mb' }), async (req, res) => {
    const { server, shutdown } = createAlteaServer({ makeClient: shared, log, readTimeoutMs, actionTimeoutMs, mutex, shared: true });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', async () => { await transport.close().catch(() => {}); await shutdown().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log(`mcp: ${e?.message || e}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });
  const noStream = (req, res) => { res.set('Allow', 'POST'); res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'This server is stateless: use POST for every request.' }, id: null }); };
  app.get('/mcp', auth, noStream);
  app.delete('/mcp', auth, noStream);

  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => { log(`http: ${err?.message || err}`); if (!res.headersSent) res.status(err?.status || 500).json({ error: err?.status ? err.message : 'internal error' }); });

  const shutdown = async () => { clearInterval(idle); if (alive) clearInterval(alive); if (client) await client.close().catch(() => {}); client = null; };
  return { app, shutdown, getClient: shared, keepAlive, mcpUrl: mcpUrl.href };
}
