// MCP stdio smoke test: initialize + tools/list (no auth needed).
import { spawn } from 'node:child_process';
const p = spawn(process.execPath, ['../bin/mcp-server.mjs'], { cwd: new URL('.', import.meta.url).pathname, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; const got = [];
p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) got.push(JSON.parse(line)); } });
p.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
await new Promise((r) => setTimeout(r, 800));
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'altea_status', arguments: {} } });
await new Promise((r) => setTimeout(r, 2500));
const tools = got.find((m) => m.id === 2)?.result?.tools || [];
console.log('tools:', tools.map((t) => t.name).join(', '));
console.log('status call:', JSON.stringify(got.find((m) => m.id === 3)?.result?.content?.[0]?.text?.slice(0, 200)));
p.kill();
