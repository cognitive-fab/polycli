'use strict';
// polycli's own state: state.json (atomic write via temp file + rename) and an
// append-only events.jsonl.
const fs = require('fs');
const path = require('path');
const { paths } = require('./paths');

const STATE = () => path.join(paths.data, 'state.json');
const EVENTS = () => path.join(paths.data, 'events.jsonl');

const EMPTY = { version: 1, workstreams: [], sessions: [], shells: [], ui: { activeWorkstream: null } };

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE(), 'utf8'));
    return { ...EMPTY, ...s, ui: { ...EMPTY.ui, ...(s.ui || {}) } };
  } catch {
    return structuredClone(EMPTY);
  }
}

let timer = null;
let pending = null;
function save(state) {
  pending = state;
  if (timer) return;
  timer = setTimeout(flush, 150);
}
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!pending) return;
  const tmp = STATE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(pending, null, 2));
  fs.renameSync(tmp, STATE());
  pending = null;
}

function event(kind, data) {
  try {
    fs.appendFileSync(EVENTS(), JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + '\n');
  } catch {}
}

module.exports = { load, save, flush, event };
