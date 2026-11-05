'use strict';
// The Cowork bridge pipe. The polycli-bridge desktop extension connects here, one
// connection per tool call: it sends one JSON line { token, op, args } and gets one
// JSON line back { ok, result } or { ok: false, error }.
//
// Separate from the hook pipe, and authenticated: the caller must present the install
// token from %APPDATA%\polycli\bridge.token (32 random bytes, created on first run).
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const { paths, pipePath } = require('./paths');
const store = require('./store');

const MAX_LINE = 256 * 1024;
// The extension computes the same name (bridge/server/index.js): keep them in step.
const bridgePipeName = () => process.env.POLYCLI_BRIDGE_PIPE || `polycli-bridge-${(require('os').userInfo().username || 'user').replace(/[^\w.-]/g, '_')}`;
const tokenFile = () => path.join(paths.home, 'bridge.token');

function ensureToken() {
  const f = tokenFile();
  try {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  } catch {}
  const t = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

class BridgeServer extends EventEmitter {
  constructor(cowork) {
    super();
    this.cowork = cowork;
    this.tokenHash = crypto.createHash('sha256').update(ensureToken()).digest();
  }
  authorized(token) {
    if (typeof token !== 'string') return false;
    const h = crypto.createHash('sha256').update(token).digest();
    return crypto.timingSafeEqual(h, this.tokenHash);
  }
  start() {
    this.server = net.createServer(sock => {
      let buf = '';
      let done = false;
      sock.setEncoding('utf8');
      const reply = msg => { if (done) return; done = true; try { sock.end(JSON.stringify(msg) + '\n'); } catch {} };
      sock.on('data', async d => {
        if (done) return;
        buf += d;
        if (buf.length > MAX_LINE) return reply({ ok: false, error: 'request too large' });
        const i = buf.indexOf('\n');
        if (i < 0) return;
        let req;
        try { req = JSON.parse(buf.slice(0, i)); } catch { return reply({ ok: false, error: 'bad request' }); }
        if (!this.authorized(req.token)) {
          store.event('bridge-denied', {});
          return reply({ ok: false, error: 'polycli rejected the bridge token. Reinstall the polycli bridge extension, or restart polycli.' });
        }
        const op = String(req.op || '');
        store.event('bridge-call', { op });
        try {
          reply({ ok: true, result: await this.cowork.handle(op, req.args) });
        } catch (e) {
          reply({ ok: false, error: String(e.message || e) });
        }
      });
      sock.on('error', () => {});
    });
    this.server.on('error', e => this.emit('error', e));
    this.server.listen(pipePath(bridgePipeName()));
  }
  stop() { this.server?.close(); }
}

// Installing the extension: the desktop app opens its "Install extension" dialog when
// started with a .mcpb file (Windows has no file association for .mcpb).
function extensionFile() {
  const candidates = [
    path.join(process.resourcesPath || '', 'polycli-bridge.mcpb'),
    path.join(__dirname, '..', '..', '..', 'out', 'polycli-bridge.mcpb'),
  ];
  return candidates.find(f => f && fs.existsSync(f)) || null;
}
function desktopExe() {
  return new Promise(resolve => {
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-Command', "(Get-AppxPackage -Name 'Claude' | Select-Object -First 1).InstallLocation"], { windowsHide: true, timeout: 15000 }, (err, out) => {
      const dir = String(out || '').trim();
      const exe = dir && path.join(dir, 'app', 'claude.exe');
      resolve(exe && fs.existsSync(exe) ? exe : null);
    });
  });
}
async function installExtension() {
  const file = extensionFile();
  if (!file) throw new Error('The extension is not built yet: run "npm run bridge:pack" in the app folder.');
  const exe = await desktopExe();
  if (!exe) throw new Error('The Claude desktop app was not found. Install it, or open the file yourself: ' + file);
  require('child_process').spawn(exe, [file], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return file;
}

module.exports = { BridgeServer, bridgePipeName, tokenFile, ensureToken, installExtension };
