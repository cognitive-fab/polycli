// polycli bridge: a zero-dependency stdio MCP server, installed as a Claude desktop
// extension. Cowork tasks call these tools; each call is forwarded to the running
// polycli app over a local named pipe, authenticated with polycli's install token.
// One process serves every Cowork task, so it keeps no per-caller state: a task
// identifies itself with the link token it got from polycli_link.
'use strict';
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');

const VERSION = '0.1.0';
// Same rules as polycli (app/src/main/paths.js and bridge.js).
const HOME = process.env.POLYCLI_HOME || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'polycli');
const PIPE = '\\\\.\\pipe\\' + (process.env.POLYCLI_BRIDGE_PIPE || `polycli-bridge-${(os.userInfo().username || 'user').replace(/[^\w.-]/g, '_')}`);
const TOKEN_FILE = path.join(HOME, 'bridge.token');
const CALL_TIMEOUT_MS = 38000;   // Cowork's relay fails a call at 60 s

const LINK = { type: 'string', description: 'The link token returned by polycli_link (starts with lnk_). Keep it for the whole task.' };
const WAIT = max => ({ type: 'number', description: `Seconds to wait for a result before returning (0-${max}). Default ${Math.min(30, max)}.` });

const TOOLS = [
  {
    name: 'polycli_list',
    description: 'List the polycli workstreams on this computer and their Claude Code CLI sessions (name, state, folder, model). polycli is the user\'s terminal app for Claude Code sessions. Use it to find the workstream and session names for the other tools.',
    inputSchema: { type: 'object', properties: { workstream: { type: 'string', description: 'Only this workstream (name).' } } },
  },
  {
    name: 'polycli_link',
    description: 'Ask to link this Cowork task to a polycli workstream. Call it once per task, before any other polycli tool except polycli_list. Returns a link token (lnk_…): keep it and pass it to every later polycli call in this task. The user approves the link in polycli; then poll polycli_link_status with the token, waiting at least 10 seconds between polls. A pending link expires after 10 minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        task_title: { type: 'string', description: 'A short title for this Cowork task, shown to the user.' },
        workstream: { type: 'string', description: 'The workstream to link to (name from polycli_list), if known.' },
      },
      required: ['task_title'],
    },
  },
  {
    name: 'polycli_link_status',
    description: 'Check whether the user approved the link: pending, active, rejected, expired or muted. Waits up to wait_seconds for a decision. When active, also returns the workstream and its sessions.',
    inputSchema: { type: 'object', properties: { link: LINK, wait_seconds: WAIT(25) }, required: ['link'] },
  },
  {
    name: 'polycli_send',
    description: 'Send a prompt to a Claude Code CLI session of the linked workstream, as if the user typed it. The user may need to approve it in polycli first. Always pass a client_ref (any unique string for this prompt) and reuse the same client_ref if you retry, so the prompt is never sent twice. Returns a turn_id and the state (awaiting-approval, queued, running, needs-you, done, failed, rejected); if the turn finishes within wait_seconds, the response too. Otherwise call polycli_read with the turn_id until it is done. Session prompts can take minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        link: LINK,
        session: { type: 'string', description: 'Session name ("workstream · role") or role, from polycli_list or polycli_link_status.' },
        text: { type: 'string', description: 'The prompt. Plain text, newlines allowed, up to 20000 characters.' },
        client_ref: { type: 'string', description: 'Unique id you choose for this prompt; reuse it when retrying.' },
        wait_seconds: WAIT(35),
      },
      required: ['link', 'session', 'text', 'client_ref'],
    },
  },
  {
    name: 'polycli_read',
    description: 'Get the state and, when done, the response of a prompt sent with polycli_send. Waits up to wait_seconds for the turn to change. needs-you means Claude is waiting for the user in polycli (for example a permission prompt): keep polling.',
    inputSchema: { type: 'object', properties: { link: LINK, turn_id: { type: 'string' }, wait_seconds: WAIT(35) }, required: ['link', 'turn_id'] },
  },
  {
    name: 'polycli_status',
    description: 'Live state of a session of the linked workstream (idle, busy, needs-you, closed…), its model, folder and branch, and the prompts waiting for it.',
    inputSchema: { type: 'object', properties: { link: LINK, session: { type: 'string' } }, required: ['link', 'session'] },
  },
  {
    name: 'polycli_open_session',
    description: 'Start a new Claude Code CLI session in the linked workstream, for parallel work (named "workstream · role"). The user approves it in polycli unless they allowed it. Optionally give a first prompt. Pass a client_ref and reuse it to check on the request later; returns the session name and, with a prompt, a turn_id for polycli_read.',
    inputSchema: {
      type: 'object',
      properties: {
        link: LINK,
        role: { type: 'string', description: 'Short role for the session, e.g. "tests" or "docs".' },
        client_ref: { type: 'string', description: 'Unique id you choose for this request; reuse it to check on it.' },
        prompt: { type: 'string', description: 'Optional first prompt for the session.' },
        cwd: { type: 'string', description: 'Folder (absolute). Default: the workstream folder.' },
        model: { type: 'string', enum: ['opus', 'sonnet', 'haiku'] },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        wait_seconds: WAIT(35),
      },
      required: ['link', 'role', 'client_ref'],
    },
  },
  {
    name: 'polycli_add_artifact',
    description: 'Report an artifact or document this Cowork task produced for the linked workstream, so the user finds it in polycli next to the sessions. Call it for every artifact or document you create for this work: a claude.ai link (url) or a file on this computer (path).',
    inputSchema: {
      type: 'object',
      properties: {
        link: LINK,
        title: { type: 'string' },
        kind: { type: 'string', description: 'artifact, document, spreadsheet, slides, design, link…' },
        url: { type: 'string', description: 'https:// link.' },
        path: { type: 'string', description: 'Absolute path of a file on this computer.' },
        description: { type: 'string' },
      },
      required: ['link', 'title'],
    },
  },
];
const OPS = { polycli_list: 'list', polycli_link: 'link', polycli_link_status: 'link_status', polycli_send: 'send', polycli_read: 'read', polycli_status: 'status', polycli_open_session: 'open_session', polycli_add_artifact: 'add_artifact' };

function readToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return null; }
}

// One connection per call: send { token, op, args }, read one JSON line back.
function call(op, args) {
  return new Promise(resolve => {
    const token = readToken();
    if (!token) return resolve({ ok: false, error: 'polycli is not set up on this computer (no bridge token). Start polycli once.' });
    let buf = '';
    let settled = false;
    const done = r => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch {} resolve(r); };
    const sock = net.connect(PIPE);
    const timer = setTimeout(() => done({ ok: false, error: 'polycli did not answer in time. Retry the same call (reuse client_ref), or poll polycli_read.' }), CALL_TIMEOUT_MS);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ token, op, args }) + '\n'));
    sock.on('data', d => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try { done(JSON.parse(buf.slice(0, i))); } catch { done({ ok: false, error: 'bad answer from polycli' }); }
    });
    sock.on('error', e => done({ ok: false, error: e.code === 'ENOENT' ? 'polycli is not running on this computer. Ask the user to start it.' : `cannot reach polycli: ${e.message}` }));
    sock.on('close', () => done({ ok: false, error: 'polycli closed the connection' }));
  });
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
const text = (obj, isError = false) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }], ...(isError ? { isError: true } : {}) });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'polycli-bridge', version: VERSION } } });
  }
  if (method && method.startsWith('notifications/')) return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const name = params && params.name;
    const op = OPS[name];
    if (!op) return send({ jsonrpc: '2.0', id, result: text(`Unknown tool ${name}`, true) });
    const r = await call(op, (params && params.arguments) || {});
    return send({ jsonrpc: '2.0', id, result: r.ok ? text(r.result) : text(r.error || 'polycli error', true) });
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

// Calls are handled concurrently: one Cowork task's long poll never blocks another's.
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch(e => { if (msg && msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: text(String(e && e.message || e), true) }); });
});
process.stdin.on('end', () => process.exit(0));

module.exports = { TOOLS };
