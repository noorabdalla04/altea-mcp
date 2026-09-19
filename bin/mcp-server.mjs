#!/usr/bin/env node
// altea MCP server over stdio. Register: claude mcp add -s user altea -- "$(which node)" "$PWD/bin/mcp-server.mjs"
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAlteaServer } from '../src/server.mjs';

const log = (m) => process.stderr.write(`[altea-mcp] ${m}\n`);
const { server, shutdown } = createAlteaServer({ log });
await server.connect(new StdioServerTransport());
log('ready');
const bye = async () => { await shutdown(); process.exit(0); };
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, bye);
server.server.onclose = bye; // host disconnected (stdin EOF): close Chrome if open, then exit
