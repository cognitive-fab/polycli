'use strict';
// Time and tokens per workstream.
//
// Two counters, both kept in hourly buckets (local time) in state.billing so that a
// week (Monday 07:00 local) or a month is a sum of buckets:
//   bill: seconds *I* worked on a billable workstream: it is the selected one,
//         polycli is the focused window, I am not idle, and no Claude session of the
//         workstream is generating (generation time is not mine to bill).
//   gen / out: Claude's generation time (turn_duration) and output tokens, read from
//         the session transcripts. Transcripts are read incrementally and only
//         appended to, so numbers survive Claude pruning old transcripts.
const fs = require('fs');

const TICK_MS = 5000;
const SCAN_MS = 20000;
const IDLE_LIMIT_S = 300;        // no keyboard or mouse for 5 minutes: stop counting
const SCAN_CHUNK = 4 << 20;

const pad = n => String(n).padStart(2, '0');
const hourKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
const hourStart = hk => new Date(+hk.slice(0, 4), +hk.slice(5, 7) - 1, +hk.slice(8, 10), +hk.slice(11, 13));

// The Monday 07:00 (local) at or before `now`.
function weekStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(7, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (d > now) d.setDate(d.getDate() - 7);
  return d;
}

class Billing {
  // isActive(): polycli is visible, focused and not minimized. idleSeconds(): system idle time.
  constructor(manager, { isActive, idleSeconds }) {
    this.m = manager;
    this.isActive = isActive;
    this.idleSeconds = idleSeconds;
    this.running = false;
    this.last = Date.now();
  }
  get b() {
    const s = this.m.state;
    if (!s.billing) s.billing = { workstreams: {}, hours: {}, scans: {} };
    return s.billing;
  }
  start() {
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.scanTimer = setInterval(() => this.scan(), SCAN_MS);
    setTimeout(() => this.scan(), 3000);
  }
  stop() { clearInterval(this.tickTimer); clearInterval(this.scanTimer); this.scan(); }

  // Keyed by workstream id; the name is kept so history still reads after a rename or removal.
  entry(w) {
    const f = this.b.workstreams[w.id] || (this.b.workstreams[w.id] = { label: w.name, billable: false });
    f.label = w.name;
    return f;
  }
  bucket(key, hk) {
    const h = this.b.hours[key] || (this.b.hours[key] = {});
    return h[hk] || (h[hk] = { bill: 0, gen: 0, out: 0 });
  }
  isBillable(id) { return !!this.b.workstreams[id]?.billable; }
  setBillable(w, on) {
    this.entry(w).billable = !!on;
    this.m.changed();
  }

  activeWs() {
    return this.m.state.workstreams.find(w => w.id === this.m.state.ui.activeWorkstream && !w.archived) || null;
  }

  tick() {
    const now = Date.now();
    const dt = Math.min((now - this.last) / 1000, TICK_MS * 2 / 1000);
    this.last = now;
    const w = this.activeWs();
    const was = this.running;
    this.running = false;
    if (w && this.isBillable(w.id) && this.isActive() && this.idleSeconds() < IDLE_LIMIT_S
      && !this.m.state.sessions.some(s => s.workstreamId === w.id && s.state === 'busy')) {
      this.bucket(w.id, hourKey(new Date(now))).bill += dt;
      this.running = true;
    }
    if (this.running || was) this.m.changed();
  }

  // ---------- transcripts ----------
  scan() {
    let changed = false;
    for (const s of this.m.state.sessions) {
      const w = this.m.state.workstreams.find(x => x.id === s.workstreamId);
      if (w && s.transcriptPath) { try { changed = this.scanOne(s.transcriptPath, w) || changed; } catch {} }
    }
    if (changed) this.m.changed();
  }
  scanOne(p, w) {
    const key = w.id;
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (!st) return false;
    const sc = this.b.scans[p] || (this.b.scans[p] = { offset: 0, lastId: null, lastTok: 0, key });
    if (st.size < sc.offset) { sc.offset = st.size; return false; }   // rewritten: never count twice
    if (st.size === sc.offset) return false;
    const len = Math.min(st.size - sc.offset, SCAN_CHUNK);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p, 'r');
    try { fs.readSync(fd, buf, 0, len, sc.offset); } finally { fs.closeSync(fd); }
    const nl = buf.lastIndexOf(10);
    if (nl < 0) return false;          // no complete line yet (or one longer than a chunk)
    sc.offset += nl + 1;
    this.entry(w);
    let any = false;
    for (const line of buf.subarray(0, nl + 1).toString('utf8').split('\n')) {
      if (!line || !(line.includes('"usage"') || line.includes('turn_duration'))) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const at = new Date(o.timestamp);
      if (isNaN(at)) continue;
      if (o.type === 'assistant' && o.message?.usage) {
        // A message is written once per content block, each with the same usage.
        const id = o.message.id, tok = o.message.usage.output_tokens || 0;
        const add = id && id === sc.lastId ? Math.max(0, tok - sc.lastTok) : tok;
        if (id === sc.lastId) sc.lastTok = Math.max(sc.lastTok, tok); else { sc.lastId = id; sc.lastTok = tok; }
        if (add) { this.bucket(sc.key, hourKey(at)).out += add; any = true; }
      } else if (o.subtype === 'turn_duration' && o.durationMs > 0) {
        this.bucket(sc.key, hourKey(at)).gen += o.durationMs / 1000; any = true;
      }
    }
    return any;
  }

  // ---------- numbers ----------
  sum(key, from) {
    const t = { bill: 0, gen: 0, out: 0 };
    for (const [hk, v] of Object.entries(this.b.hours[key] || {})) {
      if (from(hk)) { t.bill += v.bill; t.gen += v.gen; t.out += v.out; }
    }
    return t;
  }
  // For the topbar: the selected workstream.
  summary() {
    const w = this.activeWs();
    if (!w) return null;
    const key = w.id, f = this.entry(w);
    const now = new Date(), ws = weekStart(now), hk = hourKey(now);
    const month = this.sum(key, k => k.startsWith(hk.slice(0, 7)));
    const today = this.sum(key, k => k.startsWith(hk.slice(0, 10)));
    const week = this.sum(key, k => hourStart(k) >= ws);
    return {
      label: w.name, billable: f.billable, running: this.running,
      todaySec: today.bill, monthSec: month.bill, weekGenSec: week.gen, weekOut: week.out, weekBillSec: week.bill, weekStart: ws.toISOString(),
    };
  }
  history() {
    const months = new Map();
    for (const [key, hours] of Object.entries(this.b.hours)) {
      const label = this.b.workstreams[key]?.label || 'removed workstream';
      for (const [hk, v] of Object.entries(hours)) {
        const mo = hk.slice(0, 7), day = hk.slice(0, 10);
        const M = months.get(mo) || months.set(mo, { month: mo, total: { bill: 0, gen: 0, out: 0 }, rows: new Map() }).get(mo);
        const R = M.rows.get(key) || M.rows.set(key, { key, label, billable: !!this.b.workstreams[key]?.billable, bill: 0, gen: 0, out: 0, days: new Map() }).get(key);
        const D = R.days.get(day) || R.days.set(day, { day, bill: 0, gen: 0, out: 0 }).get(day);
        for (const t of [M.total, R, D]) { t.bill += v.bill; t.gen += v.gen; t.out += v.out; }
      }
    }
    return [...months.values()].sort((a, b) => b.month.localeCompare(a.month)).map(M => ({
      month: M.month, total: M.total,
      rows: [...M.rows.values()].sort((a, b) => b.bill - a.bill || b.gen - a.gen).map(R => ({ ...R, days: [...R.days.values()].sort((a, b) => b.day.localeCompare(a.day)) })),
    }));
  }
}

module.exports = { Billing, weekStart, hourKey };
