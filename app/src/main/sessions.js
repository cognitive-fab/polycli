'use strict';
// Workstreams, Claude sessions and shells: their lifecycle, their status, and the
// terminals that show them.
//
// A Claude session is a `claude --bg` background session. polycli shows it through a
// pty running `claude attach <bgId>`; closing that pty never ends the session.
// Status comes from hook events (fast) reconciled against `claude agents --json`
// (slow, but authoritative on whether the session exists and is stopped).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const claude = require('./claude');
const store = require('./store');
const { writeSettings } = require('./hooks');
const { cleanEnv } = require('./env');
const secrets = require('./secrets');
const gitinfo = require('./git');
const { paths, checkedDir, tildify } = require('./paths');

const MODELS = ['', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
// Never offers bypassPermissions: polycli does not launch sessions that skip prompts.
const PERMISSION_MODES = ['', 'default', 'acceptEdits', 'plan'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ENV_MAX = 50;
const DOC_EXT = /\.(md|html?|pdf|docx?|pptx?|xlsx?|csv|txt)$/i;
const POLL_MS = 5000;
const GIT_STALE_MS = 20000;   // background refresh of the git line for open sessions
const PR_STALE_MS = 60000;    // gh pr view is slower; refreshed less often
const dirKey = d => path.resolve(d).toLowerCase();
// `claude agents --json`: a session whose process runs has a `pid` and a `status`
// (idle / busy). `state` is the task state shown in agent view: blocked (waiting for
// input), working, done (the task is finished; the process may still run, e.g. after
// a turn that completed the work), stopped. So `done` alone does not mean ended.
// A freshly launched session has no pid yet for a few seconds (more under load) and
// reads `blocked`. Ended = no entry, or no pid together with `stopped` / `done`.
const running = e => !!e && (e.pid != null || !['stopped', 'done'].includes(e.state));
const waiting = e => e.status === 'idle' || e.state === 'blocked';
// Pane writes that are not the user typing: focus and SGR mouse reports, and the
// terminal's replies to queries (DA, DSR, DECRQM, OSC, DCS).
const NOT_TYPING = /^(?:\x1b\[[IO]|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[?>]?[\d;]*[cRn]|\x1b\[\??[\d;]*\$y|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/;

const newId = () => crypto.randomUUID();
const now = () => Date.now();
const clip = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : null);
// Terminal output as plain text: no escape sequences, whitespace collapsed.
const screenText = s => s.replace(/\x1b\[[0-9;?<>=]*[a-zA-Z]/g, ' ').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\s+/g, ' ');

function cleanLabel(s, what) {
  if (typeof s !== 'string') throw new Error(`${what} is required`);
  const t = s.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!t) throw new Error(`${what} is required`);
  if (t.length > 60) throw new Error(`${what} is too long (60 characters max)`);
  return t;
}

// claude-opus-5-5 → Opus 5.5 (used until the statusLine reports a display name).
function modelDisplay(id) {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/.exec(id || '');
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id || null;
}

function git(cwd, args) {
  return new Promise(resolve => execFile('git', ['-C', cwd, ...args], { env: cleanEnv(), windowsHide: true, timeout: 5000, encoding: 'utf8' },
    (err, out) => resolve(err ? null : out.trim())));
}

// Last assistant entry of a transcript, reading only its tail.
function transcriptTail(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const l of lines) {
      if (!l.includes('"assistant"')) continue;
      try { const j = JSON.parse(l); if (j.type === 'assistant') return j; } catch {}
    }
  } catch {}
  return null;
}

class Manager extends EventEmitter {
  constructor(pty) {
    super();
    this.pty = pty;
    this.state = store.load();
    this.plan = claude.planName();
    this.expectExit = new Set();      // terminal ids we are closing on purpose
    this.reattachLog = new Map();     // session id → recent reattach timestamps
    this.blockedPolls = new Map();    // session id → consecutive "blocked" polls while busy
    this.endedPolls = new Map();      // session id → consecutive stopped/done/missing polls
    this.ops = new Map();             // session id → in-flight lifecycle operation
    this.lastOutput = new Map();      // terminal id → time of last output
    this.lastInput = new Map();       // terminal id → time the user last typed in the pane
    this.gitByDir = new Map();        // folder → { info, repo, pr, deploy, at, prAt, busy }; not saved
    this.gitTimers = new Map();       // folder → debounce timer
    pty.on('data', id => this.lastOutput.set(id, now()));
    pty.on('exit', (id, code) => this.onTermExit(id, code));
    pty.on('error', (id, message) => this.onTermExit(id, -1, message));
  }

  // ---------- state ----------
  changed() {
    store.save(this.state);
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => { this.changeTimer = null; this.emit('changed'); }, 40);
  }
  snapshot() {
    return {
      workstreams: this.state.workstreams.map(w => ({ ...w, env: (w.env || []).map(e => ({ name: e.name })), uses: w.uses || [], envRev: w.envRev || 0, folderShort: tildify(w.folder) })),
      sessions: this.state.sessions.map(s => {
        const here = s.liveCwd || s.cwd;
        const g = this.gitByDir.get(dirKey(here));
        const w = this.state.workstreams.find(x => x.id === s.workstreamId);
        const git = g && g.info ? { ...g.info, files: undefined, repo: g.repo, pr: g.pr } : null;
        const deploy = w?.deploy ? { command: w.deploy, cwdShort: tildify(here) } : g?.deploy ? { command: g.deploy.command, cwdShort: tildify(g.deploy.cwd), detected: true } : null;
        return { ...s, git, deploy, termLive: this.pty.isLive(`s:${s.id}`), trustLive: this.pty.isLive(`t:${s.id}`), cwdShort: tildify(here), startedShort: tildify(s.cwd),
          worktree: (/[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/.exec(here) || [])[1] || null };
      }),
      shells: this.state.shells.map(h => ({ ...h, termLive: this.pty.isLive(`h:${h.id}`), cwdShort: tildify(h.cwd) })),
      ui: this.state.ui,
      plan: this.plan,
    };
  }
  ws(id) {
    const w = this.state.workstreams.find(x => x.id === id);
    if (!w) throw new Error('unknown workstream');
    return w;
  }
  session(id) {
    const s = this.state.sessions.find(x => x.id === id);
    if (!s) throw new Error('unknown session');
    return s;
  }
  shell(id) {
    const h = this.state.shells.find(x => x.id === id);
    if (!h) throw new Error('unknown shell');
    return h;
  }
  set(s, patch) {
    const before = s.state;
    Object.assign(s, patch);
    if (patch.state && patch.state !== before) {
      s.stateSince = now();
      store.event('state', { session: s.id, from: before, to: patch.state });
      this.emit('session-state', s, before, patch.state);
      if (patch.state === 'needs-you') this.emit('attention', s);
    }
    this.changed();
  }

  // ---------- workstreams ----------
  createWorkstream({ name, folder, color }) {
    const w = { id: newId(), name: cleanLabel(name, 'Name'), folder: checkedDir(folder), color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#7c8cf8', createdAt: now() };
    this.state.workstreams.push(w);
    this.state.ui.activeWorkstream = w.id;
    this.changed();
    return w;
  }
  // Archive: close the workstream's sessions (conversations are kept) and shells, and
  // hide it from the rail. Restore brings it back; its sessions reopen from Closed.
  async archiveWorkstream({ id }) {
    const w = this.ws(id);
    const working = this.state.sessions.find(s => s.workstreamId === id && ['busy', 'needs-you'].includes(s.state));
    if (working) throw new Error(`Claude is working in ${working.name}; wait until it is idle.`);
    for (const s of this.state.sessions.filter(x => x.workstreamId === id && (x.open || this.pty.isLive(`t:${x.id}`)))) await this.closeSession(s.id);
    for (const h of this.state.shells.filter(x => x.workstreamId === id)) await this.closeShell(h.id);
    w.archived = now();
    if (this.state.ui.activeWorkstream === id) this.state.ui.activeWorkstream = this.state.workstreams.find(x => !x.archived)?.id || null;
    store.event('workstream-archive', { workstream: id });
    this.changed();
  }
  restoreWorkstream({ id }) {
    const w = this.ws(id);
    delete w.archived;
    this.state.ui.activeWorkstream = id;
    store.event('workstream-restore', { workstream: id });
    this.changed();
  }
  // Archived workstreams start nothing until they are restored.
  liveWs(id) {
    const w = this.ws(id);
    if (w.archived) throw new Error(`${w.name} is archived; restore it first.`);
    return w;
  }
  renameWorkstream({ id, name }) {
    const w = this.ws(id);
    w.name = cleanLabel(name, 'Name');
    this.changed();
  }
  // Workstream settings. env: [{ name, value? }]; a missing value keeps the stored one.
  // uses: names of global variables this workstream relies on (bookkeeping only).
  updateWorkstream({ id, name, color, env, uses, deploy, coworkSend, coworkOpen }) {
    const w = this.ws(id);
    // Cowork bridge policy: ask (default) or allow, for prompts and for new sessions.
    if (coworkSend !== undefined) w.coworkSend = coworkSend === 'allow' ? 'allow' : 'ask';
    if (coworkOpen !== undefined) w.coworkOpen = coworkOpen === 'allow' ? 'allow' : 'ask';
    if (deploy !== undefined) {
      const d = String(deploy ?? '').trim();
      if (d.length > 500 || /[\r\n\0]/.test(d)) throw new Error('The deploy command must be one line');
      w.deploy = d || null;
    }
    if (name !== undefined) w.name = cleanLabel(name, 'Name');
    if (color !== undefined && /^#[0-9a-f]{6}$/i.test(color)) w.color = color;
    if (env !== undefined) {
      if (!Array.isArray(env) || env.length > ENV_MAX) throw new Error(`At most ${ENV_MAX} variables`);
      const old = new Map((w.env || []).map(e => [e.name.toUpperCase(), e]));
      const seen = new Set();
      const next = [];
      for (const e of env) {
        const n = String(e?.name ?? '').trim();
        if (!ENV_NAME.test(n)) throw new Error(`"${clip(n, 40)}" is not a valid variable name`);
        if (seen.has(n.toUpperCase())) throw new Error(`${n} is listed twice`);
        seen.add(n.toUpperCase());
        if (typeof e.value === 'string') {
          if (e.value.length > 8192 || e.value.includes('\0')) throw new Error(`The value of ${n} is too long or invalid`);
          next.push({ name: n, enc: secrets.encrypt(e.value) });
        } else if (old.has(n.toUpperCase())) {
          next.push({ name: n, enc: old.get(n.toUpperCase()).enc });
        } else {
          throw new Error(`${n} needs a value`);
        }
      }
      const before = JSON.stringify(w.env || []);
      w.env = next;
      if (JSON.stringify(next) !== before) w.envRev = (w.envRev || 0) + 1;
    }
    if (uses !== undefined) {
      if (!Array.isArray(uses)) throw new Error('uses must be a list');
      w.uses = [...new Set(uses.map(u => String(u)).filter(u => ENV_NAME.test(u)))].slice(0, 200);
    }
    this.changed();
  }
  // The workstream's variables, decrypted, for a settings file or a shell.
  envFor(w) {
    const out = {};
    for (const e of w.env || []) out[e.name] = secrets.decrypt(e.enc);
    return out;
  }
  // Writes the session's settings file with the current workstream environment and
  // records which revision the session will run with.
  writeSessionSettings(s) {
    const w = this.ws(s.workstreamId);
    s.envRev = w.envRev || 0;
    return writeSettings(s.id, this.envFor(w));
  }

  setActive(id) {
    if (id) this.ws(id);
    this.state.ui.activeWorkstream = id;
    this.changed();
  }
  setUi(patch) {
    for (const k of ['activeTab', 'collapsed']) if (k in patch) this.state.ui[k] = patch[k];
    if ('theme' in patch && ['system', 'light', 'dark'].includes(patch.theme)) this.state.ui.theme = patch.theme;
    this.changed();
  }

  // ---------- Claude sessions ----------
  async newSession({ workstreamId, role, cwd, model = '', effort = '', permissionMode = '' }) {
    const w = this.liveWs(workstreamId);
    if (!MODELS.includes(model)) throw new Error('unknown model');
    if (!EFFORTS.includes(effort)) throw new Error('unknown effort');
    if (!PERMISSION_MODES.includes(permissionMode)) throw new Error('unknown permission mode');
    const s = {
      id: newId(), workstreamId: w.id, role: cleanLabel(role, 'Role'), cwd: checkedDir(cwd || w.folder),
      model, effort, permissionMode, bgId: null, sessionId: null, transcriptPath: null,
      state: 'starting', stateSince: now(), attention: null, lastPrompt: null, lastMessage: null, error: null,
      header: { version: null, model: null, effort: effort || null, branch: null }, documents: [],
      open: true, createdAt: now(),
    };
    s.name = `${w.name} · ${s.role}`;
    this.state.sessions.push(s);
    this.state.ui.activeTab = `s:${s.id}`;
    this.changed();
    store.event('session-new', { session: s.id, cwd: s.cwd });
    git(s.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).then(b => { s.header.branch = b; this.changed(); });
    // The launch takes a few seconds and reports into the record (failed + error), so
    // the caller gets the session as soon as its settings are valid.
    this.launch(s).catch(e => this.set(s, { state: 'failed', error: clip(String(e.message || e), 400) }));
    return s;
  }

  async launch(s) {
    if (!claude.isTrusted(s.cwd)) return this.startTrust(s);
    this.set(s, { state: 'starting', error: null });
    const settingsFile = this.writeSessionSettings(s);
    const r = await claude.launchBg({ cwd: s.cwd, name: s.name, settingsFile, model: s.model, effort: s.effort, permissionMode: s.permissionMode });
    if (r.untrusted) return this.startTrust(s);
    if (!r.ok) return this.set(s, { state: 'failed', error: clip(r.out.trim(), 400) || 'claude --bg failed' });
    this.set(s, { bgId: r.bgId });
    store.event('session-launched', { session: s.id, bgId: r.bgId });
    if (s.open) this.attach(s);
  }

  // Untrusted folder: the user answers Claude's own trust prompt in an interactive
  // `claude` pane; polycli never accepts trust on the user's behalf.
  startTrust(s) {
    this.set(s, { state: 'untrusted', error: null });
    const id = `t:${s.id}`;
    if (this.pty.isLive(id)) return;
    this.pty.spawn(id, claude.exe(), [], { cwd: s.cwd, env: cleanEnv(), cols: 120, rows: 32 });
    this.state.ui.activeTab = id;
    this.changed();
  }

  attach(s) {
    const id = `s:${s.id}`;
    if (!s.bgId || this.pty.isLive(id)) return;
    this.pty.spawn(id, claude.exe(), ['attach', s.bgId], { cwd: s.cwd, env: cleanEnv(), cols: s.cols || 120, rows: s.rows || 32 });
    s.elsewhere = false;
    if (['closed', 'detached', 'failed'].includes(s.state)) this.set(s, { state: 'starting' });
    // Attaching to a session that is already running doesn't always produce a
    // statusLine, so settle "starting" from the next polls (see pollOnce).
    this.schedulePoll(2500);
    this.changed();
  }

  detachTerm(id) {
    if (!this.pty.isLive(id)) return Promise.resolve();
    this.expectExit.add(id);
    return new Promise(resolve => {
      const done = () => { clearTimeout(t); this.pty.off('exit', onExit); resolve(); };
      const onExit = x => { if (x === id) done(); };
      const t = setTimeout(done, 4000);
      this.pty.on('exit', onExit);
      this.pty.kill(id);
    });
  }

  // One lifecycle operation per session at a time.
  async op(s, fn) {
    if (this.ops.get(s.id)) throw new Error('busy with another action, try again in a moment');
    this.ops.set(s.id, true);
    s.opAt = now();
    try { return await fn(); } finally { this.ops.delete(s.id); s.opAt = now(); this.changed(); }
  }

  closeSession(id) {
    const s = this.session(id);
    return this.op(s, async () => {
      s.open = false;
      if (s.bgId) {
        const r = await claude.stop(s.bgId);
        if (!r.ok && !/not found|no such|already/i.test(r.out)) this.set(s, { error: clip(r.out.trim(), 300) });
      }
      await this.detachTerm(`s:${s.id}`);
      await this.detachTerm(`t:${s.id}`);
      this.set(s, { state: s.bgId ? 'closed' : 'failed', attention: null });
      store.event('session-close', { session: s.id });
    });
  }

  reopenSession(id) {
    const s = this.session(id);
    this.liveWs(s.workstreamId);
    return this.op(s, async () => {
      s.open = true;
      this.state.ui.activeWorkstream = s.workstreamId;
      this.state.ui.activeTab = `s:${s.id}`;
      if (!s.bgId) return this.launch(s);
      this.writeSessionSettings(s);   // a stopped session restarts from it on attach
      this.attach(s);     // attach also restarts a stopped session
      store.event('session-reopen', { session: s.id });
    });
  }

  restartSession(id) {
    const s = this.session(id);
    this.liveWs(s.workstreamId);
    return this.op(s, async () => {
      if (!s.bgId) return this.launch(s);
      s.open = true;
      this.set(s, { state: 'starting', attention: null, error: null });
      await this.detachTerm(`s:${s.id}`);
      this.writeSessionSettings(s);   // respawn re-reads it: picks up environment changes
      const r = await claude.respawn(s.bgId);
      if (!r.ok) this.set(s, { error: clip(r.out.trim(), 300) });
      this.attach(s);
      store.event('session-restart', { session: s.id });
    });
  }

  deleteSession(id) {
    const s = this.session(id);
    return this.op(s, async () => {
      if (s.bgId) { await claude.stop(s.bgId); await claude.remove(s.bgId); }
      await this.detachTerm(`s:${s.id}`);
      await this.detachTerm(`t:${s.id}`);
      this.state.sessions = this.state.sessions.filter(x => x.id !== s.id);
      try { fs.rmSync(path.join(paths.run, `${s.id}.settings.json`), { force: true }); } catch {}
      store.event('session-delete', { session: s.id });
    });
  }

  // ---------- shells ----------
  // `run` is a command for this first start only (Deploy). The stored args stay a plain
  // shell, so restarting polycli never runs it again.
  newShell({ workstreamId, cwd, run, name }) {
    const w = this.liveWs(workstreamId);
    const h = { id: newId(), workstreamId: w.id, name: name || 'pwsh', cwd: checkedDir(cwd || w.folder), command: 'pwsh.exe', args: ['-NoLogo'], open: true, state: 'running', createdAt: now() };
    this.state.shells.push(h);
    this.state.ui.activeTab = `h:${h.id}`;
    this.startShell(h, run);
    return h;
  }
  startShell(h, run) {
    h.state = 'running';
    const w = this.state.workstreams.find(x => x.id === h.workstreamId);
    h.envRev = w?.envRev || 0;
    let extra = {};
    try { if (w) extra = this.envFor(w); } catch (e) { h.envRev = -1; console.error('shell environment unavailable', e.message); }
    const args = run ? [...h.args, '-NoExit', '-Command', run] : h.args;
    this.pty.spawn(`h:${h.id}`, h.command, args, { cwd: h.cwd, env: cleanEnv(extra), cols: h.cols || 120, rows: h.rows || 32 });
    this.changed();
  }
  restartShell(id) {
    const h = this.shell(id);
    h.open = true;
    if (!this.pty.isLive(`h:${h.id}`)) this.startShell(h);
  }
  async closeShell(id) {
    const h = this.shell(id);
    await this.detachTerm(`h:${h.id}`);
    this.state.shells = this.state.shells.filter(x => x.id !== h.id);
    this.changed();
  }

  // Types a prompt into an attached session the way a person would: bracketed paste,
  // a short gap, then Enter. If Claude doesn't report the prompt (UserPromptSubmit)
  // within a few seconds, Enter is sent once more: right after an attach or respawn
  // the input box can swallow the first one.
  async submitPrompt(id, text) {
    return this.pasteAndSubmit(this.session(id), [text]);
  }
  // Pastes each part (bracketed paste) and then presses Enter. Claude shows a long or
  // multi-line paste as "[Pasted text #n +k lines]" (after up to ~6 s), so either that
  // or the part's first line on screen counts as shown. Only the first part is retried,
  // when nothing showed: right after an attach the TUI drops input.
  async pasteAndSubmit(s, parts) {
    for (const text of parts) {
      if (typeof text !== 'string' || !text.trim()) throw new Error('empty prompt');
      if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new Error('prompt contains control characters');
    }
    const term = `s:${s.id}`;
    if (!this.pty.isLive(term)) throw new Error('session is not attached');
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const before = s.promptSeq || 0;
    const plain = str => str.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\s+/g, '');
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      // Claude may draw spaces as cursor moves (CSI n C), so compare without whitespace.
      const probe = text.trim().split('\n')[0].replace(/\s+/g, '').slice(0, 16);
      for (let attempt = 0; attempt < (i === 0 ? 3 : 1); attempt++) {
        const t0 = now();
        while (now() - (this.lastOutput.get(term) || 0) < 1000 && now() - t0 < 10000) await sleep(100);
        const mark = this.pty.scrollback(term).length;
        this.pty.write(term, `\x1b[200~${text}\x1b[201~`);
        const t1 = now();
        let shown = false;
        // Pasting again too early would double the text.
        while (!shown && now() - t1 < 8000) {
          await sleep(100);
          const fresh = plain(this.pty.scrollback(term).slice(Math.max(0, mark - 64)));
          shown = fresh.includes(probe) || fresh.includes('[Pastedtext#');
        }
        if (shown) break;
      }
    }
    await sleep(300);
    for (let attempt = 0; attempt < 2; attempt++) {
      this.pty.write(term, '\r');
      const t0 = now();
      while (now() - t0 < 4000) {
        if ((s.promptSeq || 0) > before) return true;
        await sleep(100);
      }
    }
    return false;
  }

  write(termId, data) {
    if (typeof data !== 'string' || data.length >= 1e6) return;
    // Typed text from the pane: the bridge doesn't paste into a prompt someone is
    // typing or pasting (keys, arrows, bracketed paste). Focus and mouse reports and
    // terminal replies (DA, DSR, mode and OSC replies) don't count.
    if (!NOT_TYPING.test(data)) this.lastInput.set(termId, now());
    this.pty.write(termId, data);
  }
  resize(termId, cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 1000 || rows > 500) return;
    const [kind, id] = termId.split(':');
    const rec = kind === 'h' ? this.state.shells.find(x => x.id === id) : this.state.sessions.find(x => x.id === id);
    if (rec) { rec.cols = cols; rec.rows = rows; }
    this.pty.resize(termId, cols, rows);
  }

  onTermExit(termId, code, message) {
    if (this.disposed) return;   // app shutdown: sessions keep running, state is saved as is
    const [kind, id] = termId.split(':');
    const expected = this.expectExit.delete(termId);
    if (kind === 'h') {
      const h = this.state.shells.find(x => x.id === id);
      if (h) { h.state = 'exited'; h.exitCode = code; this.changed(); }
      return;
    }
    const s = this.state.sessions.find(x => x.id === id);
    if (!s) return;
    if (kind === 't') {
      // Closed or deleted by polycli (or mid-action): don't launch anything.
      if (expected || this.ops.get(s.id) || !s.open) return this.changed();
      // Trust pane closed by the user: launch if they accepted the prompt.
      if (claude.isTrusted(s.cwd)) this.launch(s);
      else this.set(s, { state: 'untrusted', error: 'The folder is not trusted yet. Open the trust prompt again and accept it, then type /exit.' });
      return;
    }
    if (expected || this.ops.get(s.id)) return this.changed();
    if (message) s.error = clip(message, 300);
    // `claude attach` in another terminal takes the session over and this client
    // prints "Session opened in another window". Let it go; "Take back" reattaches.
    if (/Session opened in another window/.test(screenText(this.pty.scrollback(termId).slice(-4000)))) {
      this.set(s, { elsewhere: true });
      store.event('session-elsewhere', { session: s.id });
      return;
    }
    // The attach client went away on its own: reattach if the session still runs.
    this.set(s, { state: 'detached' });
    this.checkAndReattach(s);
  }

  async checkAndReattach(s) {
    const list = await claude.agents();
    // A failed `claude agents` call (null) says nothing about the session: only close
    // it when the list came back without it. Otherwise try to reattach; if the session
    // really ended, the next polls close it.
    const entry = list && list.find(a => a.id === s.bgId);
    if (list && !running(entry)) return this.set(s, { state: 'closed', open: false });
    const recent = (this.reattachLog.get(s.id) || []).filter(t => now() - t < 60000);
    if (!s.open || recent.length >= 3) return;   // stays "detached" with a Reattach button
    recent.push(now());
    this.reattachLog.set(s.id, recent);
    setTimeout(() => { if (s.open && !this.pty.isLive(`s:${s.id}`)) this.attach(s); }, 1000);
  }

  // ---------- hook events ----------
  onHook({ event, slot, input }) {
    const s = this.state.sessions.find(x => x.id === slot);
    if (!s) return;
    input = input && typeof input === 'object' ? input : {};
    if (input.session_id && !s.sessionId) s.sessionId = input.session_id;
    if (input.transcript_path) s.transcriptPath = input.transcript_path;
    // Before the state changes below: the bridge settles its turn on Stop first.
    this.emit('session-hook', s, event, input);
    switch (event) {
      case 'statusLine':
        Object.assign(s.header, {
          version: input.version || s.header.version,
          model: input.model?.display_name || s.header.model,
        });
        if (s.state === 'starting' || s.state === 'detached') return this.set(s, { state: 'idle' });
        return this.changed();
      case 'SessionStart':
        if (!['busy', 'needs-you', 'closed'].includes(s.state)) this.set(s, { state: 'idle' });
        return this.changed();
      case 'UserPromptSubmit':
        this.blockedPolls.delete(s.id);
        s.promptSeq = (s.promptSeq || 0) + 1;
        return this.set(s, { state: 'busy', attention: null, lastPrompt: clip(input.prompt, 300) });
      case 'Stop':
        this.gitSoon(s);
        this.readTranscriptHeader(s);
        return this.set(s, { state: 'idle', attention: null, lastMessage: clip(input.last_assistant_message, 600) });
      case 'Notification': {
        s.lastNotification = input;
        const msg = clip(input.message, 300) || 'Claude needs your attention';
        if (input.notification_type === 'idle_prompt' || /waiting for your input/i.test(msg)) return this.set(s, { state: 'idle' });
        return this.set(s, { state: 'needs-you', attention: { message: msg, since: now() } });
      }
      case 'SessionEnd':
        this.pollSoon();
        return;
      case 'PostToolUse': {
        this.gitSoon(s);
        const f = input.tool_input?.file_path;
        if (f && DOC_EXT.test(f) && !s.documents.some(d => d.path === f)) {
          s.documents.unshift({ path: f, tool: input.tool_name, at: now() });
          s.documents.length = Math.min(s.documents.length, 50);
          this.changed();
        }
        return;
      }
    }
  }

  // A session can move, e.g. into a git worktree (EnterWorktree). `cwd` stays the folder
  // it was started in; `liveCwd` is where `claude agents` says it is now. The header,
  // the branch and VS Code follow liveCwd.
  followCwd(s, dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return;
    const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    const next = same(dir, s.cwd) ? null : dir;
    if (next === (s.liveCwd || null) || (next && s.liveCwd && same(next, s.liveCwd))) return;
    if (next && !fs.existsSync(next)) return;
    s.liveCwd = next;
    this.gitSoon(s, 0);
    store.event('session-cwd', { session: s.id, cwd: next || s.cwd });
    git(next || s.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).then(b => { s.header.branch = b; this.changed(); });
    this.changed();
  }

  // ---------- git ----------
  gitSoon(s, ms = 1500) {
    const dir = s.liveCwd || s.cwd;
    const k = dirKey(dir);
    clearTimeout(this.gitTimers.get(k));
    this.gitTimers.set(k, setTimeout(() => { this.gitTimers.delete(k); this.refreshGit(dir); }, ms));
  }
  // One refresh per folder at a time; sessions sharing a folder share the result.
  // A refresh asked for while one runs is queued (at most one, merged), so a caller
  // that awaits it, like Commit and Push, always gets a read made after its change.
  refreshGit(dir, { pr = false } = {}) {
    if (this.disposed) return Promise.resolve();
    const k = dirKey(dir);
    let g = this.gitByDir.get(k);
    if (!g) this.gitByDir.set(k, g = { at: 0, prAt: 0 });
    if (g.queued) { g.queued.pr = g.queued.pr || pr; return g.queued.promise; }
    const q = { pr };
    g.queued = q;
    q.promise = (g.running || Promise.resolve()).catch(() => {}).then(() => {
      g.queued = null;
      return (g.running = this.readGit(dir, g, q.pr));
    }).finally(() => { if (!g.queued) g.running = null; });
    return q.promise;
  }
  async readGit(dir, g, pr) {
    if (this.disposed) return;
    const before = JSON.stringify([g.info, g.repo, g.pr, g.deploy]);
    g.info = await gitinfo.status(dir);
    if (g.info) {
      if (g.repo === undefined || now() - g.at > 5 * 60000) {
        g.repo = (await gitinfo.github(dir)).repo || null;
        g.deploy = await gitinfo.detectDeploy(dir);
      }
      if (!g.repo || !g.info.branch) g.pr = null;   // origin changed or removed, or detached
      else if (pr || now() - g.prAt > PR_STALE_MS) {
        g.pr = await gitinfo.pullRequest(dir);
        g.prAt = now();
      }
    } else {
      g.repo = undefined; g.pr = null; g.deploy = null;   // re-read all if it becomes a repo
    }
    g.at = now();
    if (JSON.stringify([g.info, g.repo, g.pr, g.deploy]) !== before) this.changed();
  }

  // Commit and Push act on the folder the session is in. Not while Claude is working
  // or waiting on a prompt: files may be half edited.
  gitTarget(id) {
    const s = this.session(id);
    if (['busy', 'needs-you'].includes(s.state)) throw new Error('Claude is working in this session; wait until it is idle.');
    return { s, dir: s.liveCwd || s.cwd };
  }
  async gitFiles(id) {
    const s = this.session(id);
    const st = await gitinfo.status(s.liveCwd || s.cwd);
    if (!st) throw new Error('Not a git repository');
    const root = await gitinfo.topLevel(s.liveCwd || s.cwd);
    return { ...st, rootShort: root ? tildify(root) : null };
  }
  async commitSession({ id, message, all = true }) {
    const { s, dir } = this.gitTarget(id);
    const out = await gitinfo.commit(dir, message, { all: !!all });
    store.event('git-commit', { session: s.id, dir });
    await this.refreshGit(dir, { pr: true });
    return out;
  }
  async pushSession({ id }) {
    const { s, dir } = this.gitTarget(id);
    const out = await gitinfo.push(dir);
    store.event('git-push', { session: s.id, dir });
    await this.refreshGit(dir, { pr: true });
    return out;
  }
  // Runs the deploy command in a new shell tab of the workstream, visible to the user.
  deploySession({ id }) {
    const s = this.session(id);
    const w = this.ws(s.workstreamId);
    const here = s.liveCwd || s.cwd;
    const g = this.gitByDir.get(dirKey(here));
    const target = w.deploy ? { command: w.deploy, cwd: here } : g?.deploy ? { command: g.deploy.command, cwd: g.deploy.cwd } : null;
    if (!target) throw new Error('No deploy command: set one in the workstream settings');
    store.event('deploy', { session: s.id, command: target.command, cwd: target.cwd });
    return this.newShell({ workstreamId: w.id, cwd: target.cwd, run: target.command, name: 'deploy' }).id;
  }

  readTranscriptHeader(s) {
    if (!s.transcriptPath) return;
    const a = transcriptTail(s.transcriptPath);
    if (!a) return;
    if (a.perTurnEffort) s.header.effort = a.perTurnEffort;
    if (!s.header.model && a.message?.model) s.header.model = modelDisplay(a.message.model);
    if (!s.header.version && a.version) s.header.version = a.version;
  }

  // ---------- reconciliation ----------
  startPolling() { this.schedulePoll(1500); }
  schedulePoll(ms) {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      try { await this.poll(); } finally { this.schedulePoll(POLL_MS); }
    }, ms);
  }
  pollSoon() { this.schedulePoll(300); }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try { await this.pollOnce(); } finally { this.polling = false; }
  }
  async pollOnce() {
    const mine = this.state.sessions.filter(s => s.bgId && s.state !== 'closed');
    if (!mine.length) return;
    const list = await claude.agents();
    if (!list) return;
    for (const s of mine) {
      if (this.ops.get(s.id)) continue;
      const entry = list.find(a => a.id === s.bgId);
      s.bgState = entry ? [entry.status, entry.state].filter(Boolean).join(' / ') : 'missing';
      if (!running(entry)) {
        // During a respawn or reopen Claude briefly reports the old process as done.
        // While a client is attached, or within 20 s of a lifecycle action, only three
        // such polls in a row close the session.
        if (this.pty.isLive(`s:${s.id}`) || now() - (s.opAt || 0) < 20000) {
          const n = (this.endedPolls.get(s.id) || 0) + 1;
          this.endedPolls.set(s.id, n);
          if (n < 3) continue;
        }
        this.endedPolls.delete(s.id);
        await this.detachTerm(`s:${s.id}`);
        this.set(s, { state: 'closed', open: false, attention: null });
        continue;
      }
      this.endedPolls.delete(s.id);
      if (entry.cwd) this.followCwd(s, entry.cwd);
      if (s.open) {
        const g = this.gitByDir.get(dirKey(s.liveCwd || s.cwd));
        if (!g || now() - g.at > GIT_STALE_MS) this.refreshGit(s.liveCwd || s.cwd);
      }
      // Attached and ready: Claude says it waits for input, or the attach client drew
      // its screen and has been quiet for 3 s.
      if (['starting', 'detached'].includes(s.state) && this.pty.isLive(`s:${s.id}`)) {
        const quiet = now() - (this.lastOutput.get(`s:${s.id}`) || now()) > 3000;
        if (waiting(entry) || quiet) { this.set(s, { state: 'idle' }); continue; }
      }
      // A turn that ended without a Stop hook (Ctrl+C, crash) would stay "busy";
      // two consecutive "blocked" polls (waiting for input) settle it as idle.
      if (s.state === 'busy' && entry.state === 'blocked') {
        const n = (this.blockedPolls.get(s.id) || 0) + 1;
        this.blockedPolls.set(s.id, n);
        if (n >= 2) { this.blockedPolls.delete(s.id); this.set(s, { state: 'idle' }); }
      } else {
        this.blockedPolls.delete(s.id);
      }
    }
    this.changed();
  }

  // ---------- startup ----------
  // Reattach sessions that were open when polycli last ran; restart shells.
  restore() {
    for (const s of this.state.sessions) {
      if (s.state === 'untrusted' || s.state === 'starting' && !s.bgId) { s.state = 'failed'; s.error = s.error || 'polycli closed before the session started'; }
      // busy / needs-you survive a restart as is: after a reattach Claude reports a
      // permission prompt as "blocked" just like an idle prompt, so they can't be
      // re-derived. A stale busy settles via the busy + blocked rule in pollOnce.
      if (s.open && s.bgId && s.state !== 'closed' && !s.elsewhere) {
        if (!['busy', 'needs-you'].includes(s.state)) s.state = 'detached';
        this.attach(s);
      }
    }
    for (const h of this.state.shells) if (h.open) this.startShell(h);
    this.changed();
  }

  dispose() {
    this.disposed = true;
    for (const t of this.gitTimers.values()) clearTimeout(t);
    clearTimeout(this.pollTimer);
    store.flush();
  }
}

module.exports = { Manager, modelDisplay, transcriptTail };
