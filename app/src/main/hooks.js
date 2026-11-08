'use strict';
// Hook plumbing: copies the helper scripts out of the app, writes each session's
// --settings file (hooks, statusLine and the workstream's environment), and runs the
// named-pipe server the helpers report to.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const { paths, pipePath } = require('./paths');

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd', 'PostToolUse', 'PreToolUse'];

// Scripts inside an asar can't be run by the system node, and settings files need a
// stable path, so the helpers live in %APPDATA%\polycli\bin.
function installHelpers() {
  const src = path.join(__dirname, '..', '..', 'resources', 'bin');
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(paths.bin, f));
}

const q = s => `"${s.replace(/\\/g, '/')}"`;

// slot = polycli's own session id. It ties hook events to the session record before
// the Claude session id is known. `env` is the workstream's environment: Claude applies
// a settings `env` block to the session (variables of the launching process don't
// reach a background session), and re-reads the file on respawn and on reopen.
function writeSettings(slot, env = {}) {
  const hook = path.join(paths.bin, 'hook.mjs');
  const status = path.join(paths.bin, 'status.mjs');
  const hooks = {};
  for (const ev of HOOK_EVENTS) {
    const entry = { hooks: [{ type: 'command', command: `node ${q(hook)} ${ev} ${slot} ${paths.pipeName}`, timeout: 5 }] };
    if (ev === 'PostToolUse') entry.matcher = 'Write|Edit|Artifact|AskUserQuestion';
    if (ev === 'PreToolUse') entry.matcher = 'AskUserQuestion';
    hooks[ev] = [entry];
  }
  const settings = { hooks, statusLine: { type: 'command', command: `node ${q(status)} ${slot} ${paths.pipeName}` } };
  if (Object.keys(env).length) settings.env = env;
  const file = path.join(paths.run, `${slot}.settings.json`);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}

class HookServer extends EventEmitter {
  start() {
    this.server = net.createServer(sock => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', d => {
        buf += d;
        if (buf.length > 4 * 1024 * 1024) return sock.destroy();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          try {
            const msg = JSON.parse(line);
            if (msg && typeof msg.slot === 'string' && typeof msg.event === 'string') this.emit('event', msg);
          } catch {}
        }
      });
      sock.on('error', () => {});
    });
    this.server.on('error', e => this.emit('error', e));
    this.server.listen(pipePath(paths.pipeName));
  }
  stop() { this.server?.close(); }
}

module.exports = { installHelpers, writeSettings, HookServer };
