// A pane mounted again replays the terminal's scrollback. Once the scrollback is trimmed,
// the modes Claude Code set at the start (alternate screen, mouse, bracketed paste) must
// still come first, and the replay must not start inside an escape sequence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PtyClient, trackModes } = require('../ptyclient');

const client = () => Object.assign(Object.create(PtyClient.prototype), new EventEmitter(), { buffers: new Map(), modes: new Map(), totals: new Map(), live: new Set() });
const data = (c, text) => c.onMessage({ op: 'data', id: 's:1', data: text });

test('trackModes keeps the last setting of each mode, combined parameters too', () => {
  const m = trackModes(new Map(), '\x1b[?1049h\x1b[?1000;1006h\x1b[?25l text \x1b[?25h\x1b[?1000l');
  assert.deepEqual(Object.fromEntries(m), { 1049: 'h', 1000: 'l', 1006: 'h', 25: 'h' });
});

test('a trimmed scrollback replays the modes set before its start', () => {
  const c = client();
  data(c, '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004hstart of the session');
  const frame = '\x1b[H\x1b[2Jframe ' + 'x'.repeat(1000);
  for (let i = 0; i < 300; i++) data(c, frame);   // ~300 KB: the start is trimmed away
  const b = c.scrollback('s:1');
  assert.ok(!b.includes('start of the session'));
  assert.equal(b[0], '\x1b', 'the scrollback starts at an escape sequence');
  const r = c.replay('s:1');
  assert.ok(r.startsWith('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h'));
  assert.ok(r.endsWith(b));
});

test('a cut inside a sequence followed by long plain text moves back to its start', () => {
  const c = client();
  data(c, '\x1b[?1049h' + 'a'.repeat(256 * 1024 - 4));   // the raw cut falls 4 characters into the sequence
  assert.ok(c.replay('s:1').startsWith('\x1b[?1049h'));
});

test('a cut deep inside a long OSC payload keeps the whole sequence', () => {
  const c = client();
  data(c, '\x1b[?2004h' + '\x1b]52;c;' + 'A'.repeat(256 * 1024) + '\x07' + 'b'.repeat(5000));
  const r = c.replay('s:1');
  assert.ok(c.scrollback('s:1').startsWith('\x1b]52;c;'));
  assert.ok(r.startsWith('\x1b[?2004h\x1b]52;c;'));
});

test('a cut in plain text far from any escape stays where it is', () => {
  const c = client();
  data(c, '\x1b[?1049h' + 'p'.repeat(10000) + 'q'.repeat(256 * 1024));
  const r = c.replay('s:1');
  assert.ok(r.startsWith('\x1b[?1049h' + 'q'), 'the dropped mode comes first');
  assert.equal(c.scrollback('s:1').length, 256 * 1024);
});

test('a mode switched off after the cut is replayed in order', () => {
  const c = client();
  data(c, '\x1b[?1049h');
  for (let i = 0; i < 300; i++) data(c, '\x1b[Hframe ' + 'x'.repeat(1000));
  data(c, '\x1b[?1049lback to the shell');
  const r = c.replay('s:1');
  assert.ok(r.indexOf('\x1b[?1049h') < r.indexOf('\x1b[?1049l'));
});

test('an untrimmed scrollback replays as it is; a new spawn forgets the modes', () => {
  const c = client();
  data(c, '\x1b[?1049hhello');
  assert.equal(c.replay('s:1'), '\x1b[?1049hhello');
  c.modes.set('s:1', new Map([['1049', 'h']]));
  c.child = { postMessage() {} };
  c.spawn('s:1', 'x', [], {});
  assert.equal(c.replay('s:1'), '');
});
