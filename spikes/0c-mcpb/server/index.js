// Spike 0c: zero-dependency stdio MCP server, installed as a Claude desktop extension.
// Answers: does Cowork reach a host-side extension, does each Cowork task get its own
// server process, does initialize/_meta identify the caller, and what is Cowork's
// per-call timeout. Everything goes to a host log file; stdout carries only JSON-RPC.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const LOG_DIR = path.join(process.env.APPDATA || os.homedir(), 'polycli');
const LOG = path.join(LOG_DIR, 'spike-0c.jsonl');
fs.mkdirSync(LOG_DIR, { recursive: true });

const startedAt = Date.now();
let clientInfo = null;
let calls = 0;

function log(kind, data) {
  const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, kind, ...data });
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const TOOLS = [
  {
    name: 'polycli_ping',
    description: 'polycli spike: waits delay_seconds, then returns. Used to measure the per-call timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        delay_seconds: { type: 'number', description: 'Seconds to wait before answering (0-300).' },
        note: { type: 'string', description: 'Free text echoed back, e.g. the Cowork task title.' },
      },
      required: ['delay_seconds'],
    },
  },
  {
    name: 'polycli_whoami',
    description: 'polycli spike: reports this server process id, the client info it was initialized with, and the request metadata it received.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
  },
];

const envOfInterest = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => /^(CLAUDE|MCP|ANTHROPIC_(?!API_KEY)|ELECTRON)/i.test(k) && !/KEY|TOKEN|SECRET/i.test(k)),
);
log('start', { ppid: process.ppid, argv: process.argv, cwd: process.cwd(), node: process.version, env: envOfInterest });

async function handle(msg) {
  const { id, method, params } = msg;
  log('recv', { id, method, params });
  if (method === 'initialize') {
    clientInfo = params && params.clientInfo;
    return send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'polycli-spike', version: '0.0.1' },
      },
    });
  }
  if (method === 'notifications/initialized' || (method && method.startsWith('notifications/'))) return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    calls++;
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const t0 = Date.now();
    if (name === 'polycli_ping') {
      const delay = Math.max(0, Math.min(300, Number(args.delay_seconds) || 0));
      await new Promise(r => setTimeout(r, delay * 1000));
      const result = { pong: true, waited_seconds: delay, note: args.note ?? null, server_pid: process.pid, call_number: calls };
      log('reply', { id, name, elapsed_ms: Date.now() - t0, result });
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    }
    if (name === 'polycli_whoami') {
      const result = {
        server_pid: process.pid, parent_pid: process.ppid, server_uptime_s: Math.round((Date.now() - startedAt) / 1000),
        call_number: calls, clientInfo, request_meta: (params && params._meta) ?? null, note: args.note ?? null,
      };
      log('reply', { id, name, result });
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    }
    return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${name}` } });
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return log('bad-json', { line: line.slice(0, 500) }); }
  handle(msg).catch(e => log('error', { message: String(e && e.stack || e) }));
});
process.stdin.on('end', () => { log('stdin-end', {}); process.exit(0); });
process.on('exit', code => log('exit', { code }));
