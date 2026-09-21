// Remote transport: OAuth discovery → dynamic registration → passphrase sign-in → PKCE token → authenticated
// Streamable HTTP calls, against a real express app on a loopback port with a stub Altea client (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp } from '../src/http.mjs';
import { FileOAuthProvider, redirectUriAllowed } from '../src/oauth.mjs';

const PASS = 'x7kq-m3dp-9wvz-b2tn';
const CB = 'https://claude.ai/api/mcp/auth_callback';
const ev = () => ({ id: 'evt_a_1', title: 'Hot Yin', date: '2026-09-20', weekday: 'Sun', time: '14:00', end: '14:59', start: '2026-09-20T14:00-04:00', duration: 59, studio: 'Hot Yoga Studio', community: 'Altea Ottawa', communityId: 'com_x', instructors: ['Sara N.'], instructorIds: ['res_1'], types: ['Hot Yoga'], spotsLeft: 2, full: false, myStatus: null, waitlisted: false, checkInWindow: 10, status: 'ACTIVE', url: 'https://myaltea.app/booking/evt_a_1', group: 'Boutique Fitness' });
class Stub {
  calls = 0;
  async init() { this.inits = (this.inits || 0) + 1; } async close() {}
  async status() { this.calls++; return { signedIn: true, userId: 'usr', cookies: 3, sessionExpiresAt: '2026-10-01T15:11-04:00', actions: null, windowMode: 'visible', rules: { cancelWindowMin: 480, bookingWindowMin: 2880 }, cacheTtlMs: 45000 }; }
  async schedule() { return { from: '2026-09-20', to: '2026-09-20', groups: ['Boutique Fitness'], communityId: 'com_x', days: [{ date: '2026-09-20', weekday: 'Sun', events: [ev()] }], count: 1 }; }
  async meta() { return { communities: [{ id: 'com_x', name: 'Altea Ottawa', groups: ['Boutique Fitness'], timezone: 'America/Toronto' }], types: [], instructors: [], rules: { cancelWindowMin: 480, bookingWindowMin: 2880 } }; }
}

const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o), redirect: 'manual' });
const rpc = (token, body) => ({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

async function start(t) {
  const dir = mkdtempSync(join(tmpdir(), 'altea-oauth-'));
  const provider = new FileOAuthProvider({ dir, log: () => {} });
  provider.setPassphrase(PASS);
  const stub = new Stub(); let made = 0;
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const { app, shutdown } = createHttpApp({ publicUrl: base, provider, makeClient: () => { made++; return stub; }, log: () => {} });
  const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
  t.after(async () => { await new Promise((r) => server.close(r)); await shutdown(); });
  return { base, dir, provider, stub, made: () => made };
}

async function register(base, meta = {}) {
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  const r = await fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CB], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...meta }) });
  return { as, status: r.status, client: await r.json() };
}

async function signIn(base, client, { challenge, pass = PASS, state = 'st8' }) {
  const authz = await fetch(`${base}/authorize?` + new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CB, code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'altea', resource: `${base}/mcp` }));
  const html = await authz.text();
  const reqId = html.match(/name="request" value="([^"]+)"/)?.[1];
  const login = await fetch(`${base}/login`, form({ request: reqId, passphrase: pass }));
  return { authz, html, reqId, login };
}

test('redirect allow-list: claude.ai / claude.com / loopback yes, anything else no', () => {
  for (const ok of [CB, 'https://claude.com/api/mcp/auth_callback', 'https://sub.claude.ai/x', 'http://localhost:6274/oauth/callback', 'http://127.0.0.1:41234/callback']) assert.equal(redirectUriAllowed(ok), true, ok);
  for (const bad of ['https://evil.example/cb', 'https://claude.ai.evil.example/cb', 'http://claude.ai/cb', 'javascript:alert(1)', 'not a url', 'cursor://x/callback']) assert.equal(redirectUriAllowed(bad), false, bad);
  assert.equal(redirectUriAllowed('https://app.example/cb', ['app.example']), true);
});

test('generated passphrases are four unambiguous groups', () => {
  for (let i = 0; i < 20; i++) assert.match(FileOAuthProvider.generatePassphrase(), /^[a-hj-kmnp-z2-9]{4}(-[a-hj-kmnp-z2-9]{4}){3}$/);
  assert.notEqual(FileOAuthProvider.generatePassphrase(), FileOAuthProvider.generatePassphrase());
});

test('full remote flow: metadata, registration, passphrase page, PKCE tokens, MCP calls, refresh rotation, persistence, revoke', async (t) => {
  const { base, dir, stub, made } = await start(t);
  // unauthenticated → 401 pointing at the protected-resource metadata
  const un = await fetch(`${base}/mcp`, rpc(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  assert.equal(un.status, 401);
  assert.match(un.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  const health = await (await fetch(`${base}/healthz`)).json(); assert.equal(health.ok, true); assert.equal(health.mcp, `${base}/mcp`);
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${base}/mcp`); assert.deepEqual(prm.authorization_servers, [`${base}/`]);
  const prmRoot = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json(); assert.equal(prmRoot.resource, `${base}/mcp`);
  // registration
  const { as, status, client } = await register(base);
  assert.equal(status, 201); assert.ok(client.client_id); assert.equal(as.token_endpoint, `${base}/token`); assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  const evil = await register(base, { client_name: 'Evil', redirect_uris: ['https://evil.example/cb'] });
  assert.equal(evil.status, 400); assert.match(evil.client.error_description, /not allowed/);
  // sign-in page + wrong passphrase + right passphrase
  const { verifier, challenge } = pkce();
  const wrong = await signIn(base, client, { challenge, pass: 'nope' });
  assert.equal(wrong.authz.status, 200); assert.match(wrong.html, /Connect <b>Claude<\/b> \(claude\.ai\)/); assert.ok(wrong.reqId);
  assert.equal(wrong.login.status, 401); assert.match(await wrong.login.text(), /Wrong passphrase/);
  const right = await fetch(`${base}/login`, form({ request: wrong.reqId, passphrase: PASS })); // same pending request, retried
  assert.equal(right.status, 302);
  const loc = new URL(right.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, CB); assert.equal(loc.searchParams.get('state'), 'st8');
  const code = loc.searchParams.get('code'); assert.ok(code);
  const stale = await fetch(`${base}/login`, form({ request: wrong.reqId, passphrase: PASS })); assert.equal(stale.status, 400); // consumed
  // token: wrong verifier, then right; code single-use
  const badTok = await fetch(as.token_endpoint, form({ grant_type: 'authorization_code', code, code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier-wrong', client_id: client.client_id, redirect_uri: CB }));
  assert.equal(badTok.status, 400);
  const tok = await fetch(as.token_endpoint, form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CB, resource: `${base}/mcp` }));
  assert.equal(tok.status, 200); const tokens = await tok.json();
  assert.equal(tokens.token_type, 'bearer'); assert.ok(tokens.access_token); assert.ok(tokens.refresh_token); assert.ok(tokens.expires_in > 0);
  const reuse = await fetch(as.token_endpoint, form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CB })); assert.equal(reuse.status, 400);
  // MCP over HTTP with the SDK client (stateless: initialize + tools/list + tools/call are separate requests)
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } });
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(transport);
  assert.match(mcp.getInstructions(), /8 hours/);
  const { tools } = await mcp.listTools(); assert.equal(tools.length, 12);
  const s = await mcp.callTool({ name: 'altea_status', arguments: {} });
  assert.equal(s.isError, undefined); assert.match(s.content[0].text, /^Signed in/); assert.equal(s.structuredContent.sessionExpiresAt, '2026-10-01T15:11-04:00');
  const sched = await mcp.callTool({ name: 'altea_schedule', arguments: { date: 'tomorrow' } }); assert.match(sched.content[0].text, /Hot Yin/);
  await mcp.close();
  assert.equal(made(), 1, 'one shared client across requests'); assert.ok(stub.calls >= 1);
  // GET stream is refused politely; a bad token is refused
  const g = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'text/event-stream' } }); assert.equal(g.status, 405);
  const bad = await fetch(`${base}/mcp`, rpc('nope', { jsonrpc: '2.0', id: 1, method: 'tools/list' })); assert.equal(bad.status, 401);
  // refresh rotates the pair
  const rf = await fetch(as.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }));
  assert.equal(rf.status, 200); const t2 = await rf.json(); assert.notEqual(t2.access_token, tokens.access_token);
  const old = await fetch(`${base}/mcp`, rpc(tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })); assert.equal(old.status, 401, 'old access token dies with the refresh');
  const again = await fetch(as.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })); assert.equal(again.status, 400, 'old refresh token is single-use');
  const fresh = await fetch(`${base}/mcp`, rpc(t2.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })); assert.equal(fresh.status, 200);
  // file-backed: a new provider over the same directory knows the client and the token; revoke-all signs out
  const p2 = new FileOAuthProvider({ dir });
  assert.equal(p2.clientsStore.getClient(client.client_id).client_name, 'Claude');
  const info = await p2.verifyAccessToken(t2.access_token); assert.equal(info.clientId, client.client_id); assert.deepEqual(info.scopes, ['altea']);
  assert.deepEqual(p2.tokenCounts(), { access: 1, refresh: 1 });
  assert.equal(p2.revokeAll(), 2);
  await assert.rejects(p2.verifyAccessToken(t2.access_token));
});

test('five wrong passphrases lock the sign-in page for a while', async (t) => {
  const { base } = await start(t);
  const { client } = await register(base);
  const { challenge } = pkce();
  const { reqId } = await signIn(base, client, { challenge, pass: 'nope1' });
  for (let i = 0; i < 4; i++) assert.equal((await fetch(`${base}/login`, form({ request: reqId, passphrase: `nope${i}` }))).status, 401);
  const locked = await fetch(`${base}/login`, form({ request: reqId, passphrase: PASS }));
  assert.equal(locked.status, 429); assert.match(await locked.text(), /Too many attempts/);
});

test('tokens survive a server restart and the stateless endpoint needs no session id', async (t) => {
  const { base, dir, provider } = await start(t);
  const { as, client } = await register(base);
  const { verifier, challenge } = pkce();
  const { login } = await signIn(base, client, { challenge });
  const code = new URL(login.headers.get('location')).searchParams.get('code');
  const tokens = await (await fetch(as.token_endpoint, form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CB }))).json();
  // "restart": a second app over the same oauth directory, new port
  const port = await freePort(); const base2 = `http://localhost:${port}`;
  const { app, shutdown } = createHttpApp({ publicUrl: base2, provider: new FileOAuthProvider({ dir }), makeClient: () => new Stub(), log: () => {} });
  const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
  t.after(async () => { await new Promise((r) => server.close(r)); await shutdown(); });
  const r = await fetch(`${base2}/mcp`, rpc(tokens.access_token, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'altea_status', arguments: {} } }));
  assert.equal(r.status, 200); const body = await r.json(); assert.equal(body.id, 7); assert.match(body.result.content[0].text, /^Signed in/);
  assert.equal(r.headers.get('mcp-session-id'), null);
  assert.ok(provider.hasPassphrase());
});
