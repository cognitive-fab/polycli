'use strict';
// The Tests tab: runs a workstream folder's package.json test and check scripts and
// turns the output into numbers (node:test, TAP and Jest summaries; failing names).
// History is kept in .polycli/test-runs.json so progress over time can be shown.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { cleanEnv } = require('./env');

const HISTORY_MAX = 60;
const TAIL_LINES = 14;
const OUT_MAX = 4 << 20;
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const now = () => Date.now();

// test* → tests; check*, verify*, selftest*, typecheck, lint → checks (the "checkable"
// phase of poly projects); ci → everything. build, start and the like are not offered.
function groupOf(name) {
  if (/^test/.test(name)) return 'tests';
  if (/^(check|verify|selftest|typecheck|lint|smoke)/.test(name)) return 'checks';
  if (name === 'ci') return 'ci';
  return null;
}

function countTestFiles(folder) {
  let n = 0;
  const walk = (dir, depth) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      if (n > 5000 || d.name === 'node_modules' || d.name.startsWith('.')) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (depth < 4) walk(p, depth + 1); }
      else if (/\.(test|spec)\.[cm]?[jt]sx?$|^selftest[\w.-]*\.[cm]?js$|^test[\w.-]*\.[cm]?js$/.test(d.name)) n++;
    }
  };
  for (const t of ['test', 'tests', '__tests__']) walk(path.join(folder, t), 0);
  return n;
}

const sumAll = (text, re) => { let t = 0, any = false; for (const m of text.matchAll(re)) { t += +m[1]; any = true; } return any ? t : null; };

// Totals from the whole output. A chained script (a && b && c) prints one summary per
// command, so every summary found is added up.
function parseSummary(text) {
  let tests = sumAll(text, /^[ℹ#]\s+tests\s+(\d+)\s*$/gm);
  let pass = sumAll(text, /^[ℹ#]\s+pass\s+(\d+)\s*$/gm);
  let fail = sumAll(text, /^[ℹ#]\s+fail\s+(\d+)\s*$/gm);
  let skip = sumAll(text, /^[ℹ#]\s+(?:skipped|todo)\s+(\d+)\s*$/gm);
  let ms = sumAll(text, /^[ℹ#]\s+duration_ms\s+([\d.]+)\s*$/gm);
  if (tests === null) {
    const j = [...text.matchAll(/^Tests:\s+(?:(\d+) failed, )?(?:(\d+) skipped, )?(?:(\d+) passed, )?(\d+) total/gm)];
    if (j.length) {
      tests = j.reduce((a, m) => a + +m[4], 0); fail = j.reduce((a, m) => a + +(m[1] || 0), 0);
      skip = j.reduce((a, m) => a + +(m[2] || 0), 0); pass = j.reduce((a, m) => a + +(m[3] || 0), 0);
    }
  }
  return { tests, pass, fail, skip, ms: ms === null ? null : Math.round(ms) };
}

function failedNames(text) {
  const out = new Set();
  for (const raw of text.split('\n')) {
    const m = /^\s*(?:✖|✗|×)\s+(.+?)(?:\s+\([\d.]+ms\))?\s*$/.exec(raw) || /^\s*not ok \d+ - (.+?)(?:\s+#.*)?\s*$/.exec(raw);
    if (m && !/^(failing tests|tests?\s+\d+)/i.test(m[1])) out.add(m[1].slice(0, 160));
    if (out.size >= 25) break;
  }
  return [...out];
}

class Tests extends EventEmitter {
  constructor(manager) {
    super();
    this.m = manager;
    this.runs = new Map();   // workstream id → run in progress
  }
  folder(wsId) { return this.m.ws(wsId).folder; }
  histFile(wsId) { return path.join(this.folder(wsId), '.polycli', 'test-runs.json'); }
  history(wsId) {
    try { const h = JSON.parse(fs.readFileSync(this.histFile(wsId), 'utf8')); return Array.isArray(h) ? h : []; } catch { return []; }
  }
  // The folders with a package.json: the workstream folder, each folder directly under
  // it (an app/ beside a repo-level README) and each one under packages/.
  packageDirs(wsId) {
    const root = this.folder(wsId);
    const dirs = [''];
    const kids = (rel) => { try { return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).filter(d => d.isDirectory() && !/^(\.|node_modules$|out$|dist$)/.test(d.name)).map(d => (rel ? `${rel}/` : '') + d.name); } catch { return []; } };
    for (const d of [...kids(''), ...kids('packages')]) dirs.push(d);
    return dirs.filter(d => fs.existsSync(path.join(root, d, 'package.json'))).slice(0, 30);
  }
  scripts(wsId) {
    const root = this.folder(wsId);
    const order = { tests: 0, checks: 1, ci: 2 };
    const scripts = [];
    let name = null;
    for (const dir of this.packageDirs(wsId)) {
      let pkg;
      try { pkg = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8')); } catch { continue; }
      if (!pkg || typeof pkg !== 'object') continue;
      if (name === null) name = pkg.name || null;
      const mine = Object.entries(pkg.scripts || {}).map(([n, cmd]) => ({ dir, name: n, label: dir ? `${dir}: ${n}` : n, cmd: String(cmd).slice(0, 300), group: groupOf(n) })).filter(s => s.group && /^[\w:.-]+$/.test(s.name));
      mine.sort((a, b) => order[a.group] - order[b.group] || a.name.localeCompare(b.name));
      scripts.push(...mine);
    }
    return { name, scripts };
  }
  info(wsId) {
    const r = this.runs.get(wsId);
    return {
      ...this.scripts(wsId), files: this.packageDirs(wsId).reduce((n, d) => n + countTestFiles(path.join(this.folder(wsId), d)), 0), history: this.history(wsId),
      running: r ? { script: r.script, startedAt: r.startedAt, pass: r.pass, fail: r.fail, tail: r.tail } : null,
    };
  }

  run(wsId, script) {
    const w = this.m.liveWs(wsId);
    if (this.runs.has(wsId)) throw new Error('A test run is already in progress');
    const known = this.scripts(wsId).scripts.find(s => s.label === script);
    if (!known) throw new Error('unknown script');
    let extra = {};
    let envError = null;
    try { extra = this.m.envFor(w); } catch (e) { envError = e.message; console.error('test environment unavailable', e.message); }
    const run = { script, startedAt: now(), pass: 0, fail: 0, tail: envError ? [`polycli: the workstream's environment variables could not be read (${envError}); running without them.`] : [], text: '', carry: '' };
    this.runs.set(wsId, run);
    const child = spawn(`npm run ${known.name}`, { cwd: path.join(w.folder, known.dir), env: cleanEnv({ ...extra, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' }), shell: true, windowsHide: true });
    run.child = child;
    const feed = d => {
      const s = d.toString('utf8').replace(ANSI, '');
      if (run.text.length < OUT_MAX) run.text += s;
      const lines = (run.carry + s).split(/\r?\n/);
      run.carry = lines.pop();
      for (const l of lines) {
        // Not \b: ✔ and the space after it are both non-word characters.
        if (/^\s*(?:✔|✓|ok \d+)(?:\s|$)/.test(l)) run.pass++;
        else if (/^\s*(?:✖|✗|×|not ok \d+)(?:\s|$)/.test(l)) run.fail++;
        if (l.trim()) { run.tail.push(l.slice(0, 200)); if (run.tail.length > TAIL_LINES) run.tail.shift(); }
      }
      this.emit('event', { workstreamId: wsId, type: 'progress', pass: run.pass, fail: run.fail, tail: run.tail });
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', e => feed(Buffer.from(`\n${e.message}\n`)));
    child.on('close', code => {
      if (run.carry) feed(Buffer.from('\n'));
      this.runs.delete(wsId);
      const s = parseSummary(run.text);
      const failed = failedNames(run.text);
      const ok = code === 0 && !run.stopped;
      const entry = {
        at: run.startedAt, script, ok, exit: run.stopped ? 'stopped' : code, ms: s.ms ?? now() - run.startedAt,
        // No summary and no ✔/✖ lines: the script gives no counts, only its exit code.
        ...([s.tests, s.pass, s.fail, s.skip].some(v => v != null) || run.pass + run.fail
          ? { tests: s.tests ?? run.pass + run.fail, pass: s.pass ?? run.pass, fail: s.fail ?? run.fail, skip: s.skip ?? 0 }
          : { tests: null, pass: null, fail: null, skip: null }),
        failed, tail: ok ? undefined : run.text.split('\n').slice(-40).join('\n').slice(-4000),
      };
      const hist = this.history(wsId);
      hist.push(entry);
      try {
        fs.mkdirSync(path.dirname(this.histFile(wsId)), { recursive: true });
        fs.writeFileSync(this.histFile(wsId), JSON.stringify(hist.slice(-HISTORY_MAX), null, 1));
      } catch {}
      this.emit('event', { workstreamId: wsId, type: 'done', entry });
    });
    this.emit('event', { workstreamId: wsId, type: 'start', script, startedAt: run.startedAt });
  }
  stop(wsId) {
    const r = this.runs.get(wsId);
    if (!r) return;
    r.stopped = true;
    execFile('taskkill.exe', ['/pid', String(r.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  }
  dispose() { for (const id of [...this.runs.keys()]) this.stop(id); }
}

module.exports = { Tests, parseSummary, failedNames, groupOf };
