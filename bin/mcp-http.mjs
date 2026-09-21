#!/usr/bin/env node
// altea MCP server over Streamable HTTP + OAuth, for remote clients (claude.ai custom connector, the Claude apps,
// Claude Code with --transport http). Binds to localhost; put Tailscale Funnel / Cloudflare Tunnel / any TLS
// reverse proxy in front and set ALTEA_PUBLIC_URL to the public origin. See README "Use it from anywhere".
import { createHttpApp } from '../src/http.mjs';
import { FileOAuthProvider } from '../src/oauth.mjs';

const log = (m) => process.stderr.write(`[altea-http ${new Date().toISOString()}] ${m}\n`);
const port = Number(process.env.ALTEA_HTTP_PORT || 8788);
const host = process.env.ALTEA_HTTP_HOST || '127.0.0.1';
const publicUrl = process.env.ALTEA_PUBLIC_URL || `http://localhost:${port}`;

const provider = new FileOAuthProvider({ log });
if (!provider.hasPassphrase()) { log('no passphrase set: run `node bin/altea.mjs remote passphrase` first'); process.exit(2); }

const { app, shutdown, mcpUrl } = createHttpApp({ publicUrl, provider, log, trustProxy: process.env.ALTEA_TRUST_PROXY !== '0' });
const server = app.listen(port, host, () => log(`listening on http://${host}:${port}; MCP endpoint ${mcpUrl}`));
server.requestTimeout = 300_000; // bookings can take a while behind a slow proxy

const bye = async (sig) => { log(`${sig}: shutting down`); server.close(); await shutdown(); process.exit(0); };
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => bye(sig));
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.stack || e}`));
process.on('uncaughtException', (e) => { log(`uncaught exception: ${e?.stack || e}`); process.exit(1); });
