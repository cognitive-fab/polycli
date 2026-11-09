'use strict';
// Pinned shells: a shell with a command polycli runs every time the shell starts (when
// polycli starts, on Restart shell and on Run). A pinned shell can wait for another
// shell of the workstream first: until that shell's command has finished, until its
// output shows some text ("listening on"), or until a TCP port answers. A server never
// "finishes", so the text and the port are the usual choices for one.
const net = require('net');

const WHEN = ['exit', 'text', 'port'];
const WAIT_MS = 15 * 60000;          // give up waiting after 15 minutes
const TAIL = 64 * 1024;              // output kept per shell to look for text and the end marker
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Printed (invisibly, as an OSC sequence) after a pinned command ends: 1 = it succeeded.
const DONE = /\x1b\]633;polycli-done;([01])\x07/;

// The command line given to pwsh: the pinned command, then the end marker.
const wrap = cmd => `${cmd}; [Console]::Write([char]27 + ']633;polycli-done;' + [int]$? + [char]7)`;

function portOpen(port) {
  return new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = ok => { s.destroy(); resolve(ok); };
    s.setTimeout(700, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

class Pins {
  constructor(manager) {
    this.m = manager;
    this.tails = new Map();   // shell id → recent raw output since the shell started
    this.waits = new Map();   // waiting shell id → { since, checking }
    this.timer = null;
  }
  shells() { return this.m.state.shells; }
  find(id) { return this.shells().find(h => h.id === id); }

  // ---------- settings ----------
  setPin(h, { command, after, when, text, port }) {
    command = typeof command === 'string' ? command.trim() : '';
    if (!command) { delete h.pin; this.unwait(h); h.waitNote = null; h.pinError = null; return this.m.changed(); }
    if (command.length > 2000 || /[\r\n]/.test(command)) throw new Error('The command must be one line (up to 2000 characters)');
    const pin = { command, after: null };
    if (after) {
      const dep = this.find(after);
      if (!dep || dep.workstreamId !== h.workstreamId || dep.id === h.id) throw new Error('Pick another shell of this workstream to wait for');
      // No loops: following "after" from the chosen shell must not come back here.
      for (let x = dep, n = 0; x?.pin?.after && n < 50; x = this.find(x.pin.after), n++) if (x.pin.after === h.id) throw new Error(`${dep.name} already waits for this shell`);
      if (!WHEN.includes(when)) throw new Error('Choose what to wait for');
      if (when === 'exit' && !dep.pin?.command) throw new Error(`${dep.name} has no pinned command to finish; pin a command there first, or wait for text or a port`);
      if (when === 'text' && (typeof text !== 'string' || !text.trim() || text.length > 200)) throw new Error('Give the text to wait for (up to 200 characters)');
      if (when === 'port' && !(Number.isInteger(+port) && +port > 0 && +port < 65536)) throw new Error('Give a port between 1 and 65535');
      Object.assign(pin, { after: dep.id, when, text: when === 'text' ? text.trim() : null, port: when === 'port' ? +port : null });
    }
    h.pin = pin;
    this.m.changed();
  }

  // ---------- starting ----------
  // Called by startShell for a pinned shell started without an explicit command:
  // returns the command line to run now, or null when the shell waits (or failed).
  // Every shell's output is watched from its start: another shell may wait on it.
  started(h) { this.tails.set(h.id, ''); }
  commandFor(h) {
    h.pinError = null;
    h.waitNote = null;
    if (!h.pin.after) return wrap(h.pin.command);
    const dep = this.find(h.pin.after);
    if (!dep || !dep.open) { this.fail(h, 'The shell it waits for is closed'); return null; }
    h.state = 'waiting';
    h.waitNote = `Waiting for ${dep.name}: ${h.pin.when === 'exit' ? 'its command to finish' : h.pin.when === 'text' ? `“${h.pin.text}” in its output` : `port ${h.pin.port} to answer`}`;
    this.waits.set(h.id, { since: Date.now(), checking: false });
    this.ensureTimer();
    setTimeout(() => this.check(h.id), 0);
    return null;
  }
  fail(h, why) {
    this.unwait(h);
    h.state = 'failed';
    h.waitNote = null;
    h.pinError = why;
    this.m.changed();
  }
  unwait(h) {
    this.waits.delete(h.id);
    if (!this.waits.size && this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  ensureTimer() {
    if (!this.timer) this.timer = setInterval(() => { for (const id of [...this.waits.keys()]) this.check(id); }, 1000);
  }

  // ---------- watching ----------
  onData(shellId, data) {
    if (!this.tails.has(shellId)) return;
    const t = this.tails.get(shellId) + data;
    this.tails.set(shellId, t.length > TAIL ? t.slice(-TAIL) : t);
    for (const [id] of this.waits) if (this.find(id)?.pin?.after === shellId) this.check(id);
  }
  async check(id) {
    const w = this.waits.get(id);
    const h = this.find(id);
    if (!w || w.checking) return;
    if (!h || !h.open || !h.pin?.after) { this.waits.delete(id); return; }
    const dep = this.find(h.pin.after);
    if (!dep || !dep.open) return this.fail(h, `${dep?.name || 'The shell it waits for'} was closed`);
    if (Date.now() - w.since > WAIT_MS) return this.fail(h, `Gave up after 15 minutes: ${h.waitNote?.replace(/^Waiting for /, '') || ''}`);
    const out = this.tails.get(dep.id) || '';
    let ready = false;
    if (h.pin.when === 'exit') {
      const m = DONE.exec(out);
      if (m && m[1] === '0') return this.fail(h, `${dep.name}'s command failed, so this one was not started`);
      ready = !!m;
    } else if (h.pin.when === 'text') {
      ready = out.replace(ANSI, '').toLowerCase().includes(h.pin.text.toLowerCase());
    } else {
      w.checking = true;
      ready = await portOpen(h.pin.port);
      w.checking = false;
    }
    if (!ready || this.waits.get(id) !== w) return;
    this.unwait(h);
    h.waitNote = null;
    this.m.startShell(h, wrap(h.pin.command));
  }
  dispose() { if (this.timer) clearInterval(this.timer); }
}

module.exports = { Pins, wrap };
