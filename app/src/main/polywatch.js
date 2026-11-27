'use strict';
// polywatch in polycli (docs/design/v0.4.md §6): the confirmed findings still open, per
// session and per workstream, and the code-review light of each session.
//
// Reads <main repository>/.polywatch/ledger.jsonl (only complete lines, only what was
// appended), never writes it: outcomes go through polywatch's own command. Learns, per
// project, from what /code-review runs found (reviewlight.learnedFactor).
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { readNewLines } = require('./jsonl');
const { cleanEnv } = require('./env');
const { normPath } = require('./paths');
const store = require('./store');
const { light, learnedFactor, reviewFindingsFrom, posix, codeLines } = require('./reviewlight');

const REFRESH_MS = 30000;
// Findings older than this no longer count as open: a finding nobody rated in two weeks is
// history, and would otherwise keep a long-lived session red for good.
const OPEN_WINDOW_MS = 14 * 864e5;
// Which worktree a ledger review belongs to: its files carry ".claude/worktrees/<name>/"
// when the session worked in one (none for the main checkout).
const treeOfFile = f => (/^\.claude\/worktrees\/([^/]+)\//.exec(String(f || '').replace(/\\/g, '/')) || [])[1] || '';
const treeOfDir = (root, dir) => (/^\.claude\/worktrees\/([^/]+)/.exec(path.relative(root, dir).replace(/\\/g, '/')) || [])[1] || '';
const git = (cwd, args) => new Promise(resolve => execFile('git', ['--no-optional-locks', ...args], { cwd, env: cleanEnv({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }), timeout: 8000, windowsHide: true, maxBuffer: 8 << 20 },
  (err, out) => resolve(err ? null : String(out))));

class Polywatch extends EventEmitter {
  constructor(manager) {
    super();
    this.manager = manager;
    this.repos = new Map();       // repo root (normalized) → { root, offset, reviews, outcomes, watcher }
    this.rootOf = new Map();      // folder → repo root (or null)
    this.lights = new Map();      // session id → { work, push, at }
    this.pending = new Map();     // session id → a /code-review in progress { at, light, offset }
    this.state = (manager.state.codeReview ||= { projects: {} });
    this.timer = setInterval(() => this.refreshAll().catch(() => {}), REFRESH_MS);
    this.timer.unref?.();
    manager.on('session-state', (s, from, to) => {
      if (to === 'idle' && from === 'busy') { this.onStop(s).catch(() => {}); this.soon(); }
    });
    manager.on('prompt', (s, text) => this.onPrompt(s, text));
    this.soon(1000);
  }
  dispose() { clearInterval(this.timer); clearTimeout(this.soonTimer); for (const r of this.repos.values()) r.watcher?.close(); }
  soon(ms = 800) { clearTimeout(this.soonTimer); this.soonTimer = setTimeout(() => this.refreshAll().catch(() => {}), ms); }

  // The main repository of a folder (a worktree's ledger lives in the main checkout).
  async repoRoot(dir) {
    const key = normPath(dir);
    if (this.rootOf.has(key)) return this.rootOf.get(key);
    const out = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const root = out ? path.dirname(path.resolve(out.trim())) : null;
    this.rootOf.set(key, root);
    return root;
  }

  async repo(root) {
    const key = normPath(root);
    let r = this.repos.get(key);
    if (!r) {
      r = { root, offset: 0, reviews: [], outcomes: new Map(), watcher: null, has: false };
      this.repos.set(key, r);
      const dir = path.join(root, '.polywatch');
      try { r.watcher = fs.watch(dir, { persistent: false }, (_e, f) => { if (!f || /ledger/.test(f)) this.soon(); }); } catch {}
    }
    const n = await readNewLines(path.join(root, '.polywatch', 'ledger.jsonl'), r.offset);
    if (n.missing) { r.has = fs.existsSync(path.join(root, '.polywatch')); return r; }
    r.has = true;
    if (n.restarted) { r.reviews = []; r.outcomes = new Map(); }
    for (const line of n.lines) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.kind === 'review' && j.id) { j.at = Date.parse(j.createdAt) || 0; r.reviews.push(j); }
      else if (j.kind === 'finding-outcome' && j.id) r.outcomes.set(`${j.id}#${j.index}`, { verdict: j.verdict, at: Date.parse(j.at) || 0, by: j.by });
    }
    r.offset = n.offset;
    return r;
  }

  // Confirmed findings without an outcome. A finding whose file a later turn of the same
  // session changed may have been fixed: it is kept, marked, and doesn't count as open.
  findings(r, { sessionId = null, filter = null } = {}) {
    const out = [];
    const since = Date.now() - OPEN_WINDOW_MS;
    const reviews = r.reviews.filter(x => x.at >= since && (!sessionId || x.session === sessionId) && (!filter || filter(x)));
    for (const rv of reviews) {
      (rv.findings || []).forEach((f, i) => {
        if (f.status !== 'confirmed' || r.outcomes.has(`${rv.id}#${i + 1}`)) return;
        const file = posix(f.file);
        const later = r.reviews.some(x => x.session === rv.session && x.at > rv.at && (x.files || []).some(p => posix(p) === file));
        out.push({ review: rv.id, n: i + 1, severity: f.severity || 'medium', file, where: f.where || '', claim: f.claim || '', evidence: f.evidence || '', at: rv.at, session: rv.session, possiblyFixed: later });
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  lastReviewAt(s) {
    try { const p = this.manager.prompts(s.id); const hit = [...(p || [])].reverse().find(x => typeof x.text === 'string' && /^\s*\/code-review\b/.test(x.text)); return hit?.at || 0; } catch { return 0; }
  }

  // The branch span for push time: since the oldest commit not on the upstream (or not on
  // the default branch when unpublished), with the lines changed since then.
  // Cached until the branch's head, upstream or changes move (git runs are the slow part).
  async branchSpan(dir, g) {
    if (!g || g.detached) return null;
    const key = `${dir}|${g.branch}|${g.upstream}|${g.ahead}|${g.behind}|${g.changed}|${g.untracked}`;
    const hit = (this.spans ||= new Map()).get(dir);
    if (hit && hit.key === key && Date.now() - hit.at < 10 * 60e3) return hit.span;
    const span = await this.computeSpan(dir, g);
    this.spans.set(dir, { key, at: Date.now(), span });
    return span;
  }
  async computeSpan(dir, g) {
    let base = g.upstream || null;
    if (!base) for (const b of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) if (await git(dir, ['rev-parse', '--verify', '-q', b])) { base = b; break; }
    if (!base) return null;
    const times = await git(dir, ['log', '--format=%ct', `${base}..HEAD`]);
    const ts = (times || '').split('\n').filter(Boolean).map(Number);
    if (!ts.length && !(g.changed + g.untracked)) return null;
    // Code lines only: tests, docs and lockfiles don't call for a review (reviewlight.js).
    const lines = codeLines(await git(dir, ['diff', '--numstat', base]));
    return { since: ts.length ? Math.min(...ts) * 1000 : Date.now() - 3600e3, lines };
  }

  async refreshAll() {
    if (this.refreshing) { this.again = true; return; }
    this.refreshing = true;
    try {
      const sessions = this.manager.state.sessions.filter(s => s.open && s.state !== 'closed');
      // Sessions in parallel; ledgers are read once per repository first.
      const roots = await Promise.all(sessions.map(s => this.repoRoot(s.liveCwd || s.cwd)));
      for (const root of new Set(roots.filter(Boolean))) await this.repo(root);
      const results = await Promise.all(sessions.map((s, i) => this.lightFor(s, roots[i]).catch(() => null)));
      let changed = false;
      sessions.forEach((s, i) => {
        const next = results[i];
        if (!next) { if (this.lights.delete(s.id)) changed = true; return; }
        const before = JSON.stringify(this.lights.get(s.id) || null);
        this.lights.set(s.id, next);
        if (JSON.stringify(next) !== before) changed = true;
      });
      for (const id of [...this.lights.keys()]) if (!sessions.some(s => s.id === id)) { this.lights.delete(id); changed = true; }
      if (changed) this.emit('changed');
    } finally {
      this.refreshing = false;
      if (this.again) { this.again = false; this.soon(); }
    }
  }

  // One session's lights, from the ledger refreshAll has just read (never read here: two
  // sessions of one repository reading it at once would add its new lines twice).
  async lightFor(s, root) {
    {
      const dir = s.liveCwd || s.cwd;
      if (!root) return null;
      const r = this.repos.get(normPath(root));
      if (!r) return null;
      const proj = this.project(root);
      // Since the session's last /code-review, and at most the last week (a session never
      // reviewed would otherwise carry its whole history).
      const since = Math.max(this.lastReviewAt(s), Date.now() - 7 * 864e5);
      const recent = r.reviews.slice(-20);
      const open = this.findings(r, { sessionId: s.sessionId }).filter(f => !f.possiblyFixed);
      const mine = r.reviews.filter(x => x.session === s.sessionId && x.at > since);
      const g = this.manager.gitByDir?.get(path.resolve(dir).toLowerCase())?.info || null;
      const uncommitted = r.has ? 0 : await this.diffLines(dir);
      const work = light({ reviews: mine, open, recent, gitLines: uncommitted, polywatch: r.has, push: false, factor: proj.factor });
      let push = null;
      const span = await this.branchSpan(dir, g);
      if (span) {
        // The branch's own work: turns in this checkout (the same worktree, or the main
        // one), by any session, since the branch's first commit that isn't pushed.
        const tree = treeOfDir(root, dir);
        const here = x => (x.files || []).some(f => treeOfFile(f) === tree);
        const branch = r.reviews.filter(x => x.at >= span.since && here(x));
        const openAll = this.findings(r, { filter: here }).filter(f => !f.possiblyFixed && f.at >= span.since);
        push = light({ reviews: branch, open: openAll, recent, gitLines: span.lines, polywatch: r.has, push: true, factor: proj.factor });
      }
      return { work, push, open: this.findings(r, { sessionId: s.sessionId }), polywatch: r.has, root };
    }
  }

  async diffLines(dir) {
    return codeLines(await git(dir, ['diff', '--numstat', 'HEAD']));
  }

  project(root) {
    const key = normPath(root);
    const p = (this.state.projects[key] ||= { history: [] });
    p.factor = learnedFactor(p.history);
    return p;
  }
  resetLearning(root) { const key = normPath(root); this.state.projects[key] = { history: [] }; this.manager.changed(); this.soon(0); }

  // A /code-review was typed (or sent by polycli): remember the light it was run under
  // and where the transcript was, to read its findings when it ends.
  onPrompt(s, text) {
    if (!/^\s*\/code-review\b/.test(text || '')) return;
    let offset = 0;
    try { offset = fs.statSync(s.transcriptPath).size; } catch {}
    const l = this.lights.get(s.id);
    this.pending.set(s.id, { at: Date.now(), light: (l?.push || l?.work)?.color || 'green', offset, since: this.lastReviewAt(s) });
  }

  // When the session stops after a /code-review: read the review's findings from the
  // transcript, compare them with what polywatch had found, and learn.
  async onStop(s) {
    const p = this.pending.get(s.id);
    if (!p || !s.transcriptPath) return;
    const n = await readNewLines(s.transcriptPath, p.offset);
    let text = '', found = null;
    for (const line of n.lines) {
      if (line.includes('ReportFindings')) {
        try { const j = JSON.parse(line); for (const c of j.message?.content || []) if (c.name === 'ReportFindings') found = (found || []).concat((c.input?.findings || []).map(f => ({ file: posix(f.file), line: f.line }))); } catch {}
      }
      if (line.includes('task-notification') && line.includes('/code-review')) {
        try { const j = JSON.parse(line); const c = j.message?.content; text += typeof c === 'string' ? c : (c || []).map(x => x.text || '').join('\n'); } catch {}
      }
    }
    if (found === null && !/<result>/.test(text)) return;   // not finished yet (or nothing readable): wait for the next Stop
    this.pending.delete(s.id);
    if (found === null) found = reviewFindingsFrom((/<result>([\s\S]*?)<\/result>/.exec(text) || [])[1] || '');
    const root = await this.repoRoot(s.liveCwd || s.cwd);
    if (!root) return;
    const r = await this.repo(root);
    const known = new Set(r.reviews.filter(x => x.at >= (p.since || 0)).flatMap(x => (x.findings || []).filter(f => f.status === 'confirmed').map(f => posix(f.file))));
    const newFound = found.filter(f => !known.has(f.file)).length;
    const proj = this.project(root);
    proj.history.push({ at: Date.now(), light: p.light, found: found.length, newFound });
    proj.history = proj.history.slice(-30);
    proj.factor = learnedFactor(proj.history);
    store.event('code-review', { session: s.id, light: p.light, found: found.length, newFound });
    this.manager.changed();
    this.soon(0);
  }

  // Snapshot for the window: per session its lights and findings; per project its learning.
  view() {
    const sessions = {};
    // Counts only: the findings themselves (with their evidence) are fetched when the panel opens.
    for (const [id, l] of this.lights) sessions[id] = { work: l.work, push: l.push, openCount: l.open.filter(f => !f.possiblyFixed).length, allCount: l.open.length, maxSeverity: maxSev(l.open.filter(f => !f.possiblyFixed)), polywatch: l.polywatch, root: l.root };
    const projects = {};
    for (const [k, p] of Object.entries(this.state.projects)) projects[k] = { reviews: p.history.length, newFindings: p.history.filter(h => h.newFound > 0).length, factor: learnedFactor(p.history) };
    return { sessions, projects };
  }

  // The findings panel: these sessions' unrated findings, newest first.
  openFor(sessionIds) {
    return sessionIds.flatMap(id => (this.lights.get(id)?.open || []).map(f => ({ ...f, sid: id }))).sort((a, b) => b.at - a.at).slice(0, 200);
  }

  // Real or false alarm, through polywatch's own command, found where the plugin is
  // installed. polycli never writes the ledger itself.
  async outcome({ root, review, n, verdict, note }) {
    if (!/^[\w-]{4,80}$/.test(String(review)) || !Number.isInteger(+n) || !['real', 'false'].includes(verdict)) throw new Error('bad outcome');
    const plugins = await require('./claudeconfig').plugins();
    const pw = plugins.find(p => p.name === 'polywatch' && p.installPath);
    const bin = pw && path.join(pw.installPath, 'bin', 'polywatch.mjs');
    if (!bin || !fs.existsSync(bin)) throw new Error('The polywatch plugin was not found');
    const args = [bin, 'outcome', String(review), String(+n), verdict, '--by', 'user', '--dir', root];
    if (note) args.push(String(note).slice(0, 300));
    await new Promise((resolve, reject) => execFile('node', args, { env: cleanEnv(), timeout: 20000, windowsHide: true }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(out))));
    this.soon(200);
  }
}
const SEV = { high: 3, medium: 2, low: 1 };
const maxSev = list => list.reduce((m, f) => (SEV[f.severity] > (SEV[m] || 0) ? f.severity : m), null);

module.exports = { Polywatch };
