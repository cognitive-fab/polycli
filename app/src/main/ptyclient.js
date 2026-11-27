'use strict';
// Main-process side of the ptyHost utilityProcess. Keeps a bounded scrollback per
// terminal so a renderer reload or a tab switch can replay what was on screen.
const path = require('path');
const { EventEmitter } = require('events');
const { utilityProcess } = require('electron');

const SCROLLBACK = 256 * 1024;

// node-pty's Windows kill path forks a helper that prints "AttachConsole failed"
// when the console is already gone. It is harmless noise.
const NOISE = /AttachConsole failed|conpty_console_list_agent|getConsoleProcessList|^\s*at |Node\.js v|^\s*\^|^\s*$/;

// DEC private modes (CSI ? n h / l), in order: the last setting of each wins.
const MODE_SEQ = /\x1b\[\?([\d;]+)([hl])/g;
function trackModes(modes, text) {
  for (const [, params, v] of text.matchAll(MODE_SEQ)) {
    for (const n of params.split(';')) if (n) modes.set(n, v);
  }
  return modes;
}

// Where the escape sequence starting at `i` ends (the index after it), or Infinity when
// it hasn't ended yet. CSI ends at its final byte; OSC, DCS, APC, PM and SOS at BEL or
// ESC \; any other escape is two characters.
function seqEnd(b, i) {
  const k = b[i + 1];
  if (k === undefined) return Infinity;
  if (k === '[') {
    for (let j = i + 2; j < b.length; j++) { const c = b.charCodeAt(j); if (c >= 0x40 && c <= 0x7e) return j + 1; }
    return Infinity;
  }
  if (']P_^X'.includes(k)) {
    const bel = b.indexOf('\x07', i + 2), st = b.indexOf('\x1b\\', i + 2);
    const ends = [bel === -1 ? Infinity : bel + 1, st === -1 ? Infinity : st + 2];
    return Math.min(...ends);
  }
  return i + 2;
}

class PtyClient extends EventEmitter {
  constructor() {
    super();
    this.buffers = new Map();
    this.modes = new Map();    // term id → modes set before the start of its scrollback
    this.totals = new Map();   // characters ever received per terminal: positions that survive trimming
    this.live = new Set();
    this.child = utilityProcess.fork(path.join(__dirname, 'ptyhost.js'), [], { stdio: 'pipe', serviceName: 'polycli-ptyhost' });
    const log = d => String(d).split(/\r?\n/).filter(l => !NOISE.test(l)).forEach(l => console.error('[ptyhost]', l));
    this.child.stdout.on('data', log);
    this.child.stderr.on('data', log);
    this.child.on('message', m => this.onMessage(m));
    this.child.on('exit', code => {
      for (const id of this.live) this.emit('exit', id, -1);
      this.live.clear();
      this.emit('host-exit', code);
    });
  }

  onMessage(m) {
    if (m.op === 'data') {
      let b = (this.buffers.get(m.id) || '') + m.data;
      if (b.length > SCROLLBACK) {
        // Cut where an escape sequence starts, and keep the modes the dropped part set:
        // Claude Code switches to the alternate screen, mouse reporting and bracketed
        // paste once, at the start. A pane mounted again from a scrollback without them
        // drew Claude's full-screen frames into the normal screen, where each redraw
        // scrolled into the scrollback (repeated messages, leftovers after a resize),
        // and the wheel scrolled those instead of Claude's transcript.
        let cut = b.length - SCROLLBACK;
        const after = b.indexOf('\x1b', cut);
        const before = b.lastIndexOf('\x1b', cut);
        if (after !== -1 && after - cut < 4096) cut = after;
        // Inside a sequence that is still open at the cut (a long OSC payload): keep it whole.
        else if (before !== -1 && seqEnd(b, before) > cut) cut = before;
        // Plain text: cut between characters.
        else if (/[\udc00-\udfff]/.test(b[cut])) cut++;
        if (!this.modes.has(m.id)) this.modes.set(m.id, new Map());
        trackModes(this.modes.get(m.id), b.slice(0, cut));
        b = b.slice(cut);
      }
      this.buffers.set(m.id, b);
      this.totals.set(m.id, (this.totals.get(m.id) || 0) + m.data.length);
      this.emit('data', m.id, m.data);
    } else if (m.op === 'exit') {
      this.live.delete(m.id);
      this.emit('exit', m.id, m.code);
    } else if (m.op === 'error') {
      this.live.delete(m.id);
      this.emit('error', m.id, m.message);
    }
  }

  spawn(id, file, args, { cwd, env, cols, rows }) {
    this.live.add(id);
    this.buffers.set(id, '');
    this.modes.delete(id);
    this.child.postMessage({ op: 'spawn', id, file, args, cwd, env, cols, rows });
  }
  write(id, data) { if (this.live.has(id)) this.child.postMessage({ op: 'write', id, data }); }
  resize(id, cols, rows) { if (this.live.has(id)) this.child.postMessage({ op: 'resize', id, cols, rows }); }
  kill(id) { if (this.live.has(id)) this.child.postMessage({ op: 'kill', id }); }
  isLive(id) { return this.live.has(id); }
  scrollback(id) { return this.buffers.get(id) || ''; }
  // What a pane mounted now replays: the modes in force where the scrollback starts,
  // then the scrollback.
  replay(id) {
    const modes = this.modes.get(id);
    return (modes ? [...modes].map(([n, v]) => `\x1b[?${n}${v}`).join('') : '') + this.scrollback(id);
  }
  // A position in a terminal's output, and the output since a position. Indexes into
  // scrollback() stop working once it is trimmed (a busy Claude pane fills 256 KB fast).
  pos(id) { return this.totals.get(id) || 0; }
  since(id, at) {
    const b = this.buffers.get(id) || '';
    const n = this.pos(id) - at;
    return n <= 0 ? '' : n >= b.length ? b : b.slice(-n);
  }
  dispose() { try { this.child.kill(); } catch {} }
}

module.exports = { PtyClient, trackModes };
