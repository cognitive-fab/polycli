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
const { paths, checkedDir, tildify } = require('./paths');

const MODELS = ['', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
// Never offers bypassPermissions: polycli does not launch sessions that skip prompts.
const PERMISSION_MODES = ['', 'default', 'acceptEdits', 'plan'];
const DOC_EXT = /\.(md|html?|pdf|docx?|pptx?|xlsx?|csv|txt)$/i;
const POLL_MS = 5000;
// `claude agents --json` states seen so far: blocked (waiting for input), working,
// stopped, done (after `claude stop`). Anything else is passed through as bgState.
const ENDED = new Set(['stopped', 'done']);

const newId = () => crypto.randomUUID();
const now = () => Date.now();
const clip = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : null);

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
      workstreams: this.state.workstreams,
      sessions: this.state.sessions.map(s => ({ ...s, termLive: this.pty.isLive(`s:${s.id}`), trustLive: this.pty.isLive(`t:${s.id}`), cwdShort: tildify(s.cwd) })),
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
  renameWorkstream({ id, name }) {
    const w = this.ws(id);
    w.name = cleanLabel(name, 'Name');
    this.changed();
  }
  setActive(id) {
    if (id) this.ws(id);
    this.state.ui.activeWorkstream = id;
    this.changed();
  }
  setUi(patch) {
    for (const k of ['activeTab', 'collapsed']) if (k in patch) this.state.ui[k] = patch[k];
    this.changed();
  }

  // ---------- Claude sessions ----------
  async newSession({ workstreamId, role, cwd, model = '', effort = '', permissionMode = '' }) {
    const w = this.ws(workstreamId);
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
    await this.launch(s);
    return s;
  }

  async launch(s) {
    if (!claude.isTrusted(s.cwd)) return this.startTrust(s);
    this.set(s, { state: 'starting', error: null });
    const settingsFile = writeSettings(s.id);
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
    return this.op(s, async () => {
      s.open = true;
      this.state.ui.activeWorkstream = s.workstreamId;
      this.state.ui.activeTab = `s:${s.id}`;
      if (!s.bgId) return this.launch(s);
      this.attach(s);     // attach also restarts a stopped session
      store.event('session-reopen', { session: s.id });
    });
  }

  restartSession(id) {
    const s = this.session(id);
    return this.op(s, async () => {
      if (!s.bgId) return this.launch(s);
      s.open = true;
      this.set(s, { state: 'starting', attention: null, error: null });
      await this.detachTerm(`s:${s.id}`);
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
  newShell({ workstreamId, cwd }) {
    const w = this.ws(workstreamId);
    const h = { id: newId(), workstreamId: w.id, name: 'pwsh', cwd: checkedDir(cwd || w.folder), command: 'pwsh.exe', args: ['-NoLogo'], open: true, state: 'running', createdAt: now() };
    this.state.shells.push(h);
    this.state.ui.activeTab = `h:${h.id}`;
    this.startShell(h);
    return h;
  }
  startShell(h) {
    h.state = 'running';
    this.pty.spawn(`h:${h.id}`, h.command, h.args, { cwd: h.cwd, env: cleanEnv(), cols: h.cols || 120, rows: h.rows || 32 });
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
    const s = this.session(id);
    if (typeof text !== 'string' || !text.trim()) throw new Error('empty prompt');
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new Error('prompt contains control characters');
    const term = `s:${s.id}`;
    if (!this.pty.isLive(term)) throw new Error('session is not attached');
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const before = s.promptSeq || 0;
    // Right after an attach the TUI drops input until it has finished drawing: wait
    // for 1 s without output (10 s at most), then check the paste shows up on screen.
    const probe = text.trim().split('\n')[0].slice(0, 16);
    for (let attempt = 0; attempt < 3; attempt++) {
      const t0 = now();
      while (now() - (this.lastOutput.get(term) || 0) < 1000 && now() - t0 < 10000) await sleep(100);
      const mark = this.pty.scrollback(term).length;
      this.pty.write(term, `\x1b[200~${text}\x1b[201~`);
      const t1 = now();
      let shown = false;
      while (!shown && now() - t1 < 1500) {
        await sleep(100);
        shown = this.pty.scrollback(term).slice(Math.max(0, mark - 64)).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').includes(probe);
      }
      if (shown) break;
    }
    await sleep(300);
    for (let attempt = 0; attempt < 2; attempt++) {
      this.pty.write(term, '\r');
      const t0 = now();
      while (now() - t0 < 3000) {
        if ((s.promptSeq || 0) > before) return true;
        await new Promise(r => setTimeout(r, 100));
      }
    }
    return false;
  }

  // ---------- terminals ----------
  write(termId, data) { if (typeof data === 'string' && data.length < 1e6) this.pty.write(termId, data); }
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
      // Trust pane closed: launch if the user accepted the prompt.
      if (claude.isTrusted(s.cwd)) this.launch(s);
      else this.set(s, { state: 'untrusted', error: 'The folder is not trusted yet. Open the trust prompt again and accept it, then type /exit.' });
      return;
    }
    if (expected || this.ops.get(s.id)) return this.changed();
    if (message) s.error = clip(message, 300);
    // The attach client went away on its own: reattach if the session still runs.
    this.set(s, { state: 'detached' });
    this.checkAndReattach(s);
  }

  async checkAndReattach(s) {
    const list = await claude.agents();
    const entry = list && list.find(a => a.id === s.bgId);
    if (!entry || ENDED.has(entry.state)) return this.set(s, { state: 'closed', open: false });
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
    switch (event) {
      case 'statusLine':
        Object.assign(s.header, {
          version: input.version || s.header.version,
          model: input.model?.display_name || s.header.model,
        });
        if (s.state === 'starting' || s.state === 'detached') s.state = 'idle';
        return this.changed();
      case 'SessionStart':
        if (!['busy', 'needs-you'].includes(s.state)) this.set(s, { state: 'idle' });
        return this.changed();
      case 'UserPromptSubmit':
        this.blockedPolls.delete(s.id);
        s.promptSeq = (s.promptSeq || 0) + 1;
        return this.set(s, { state: 'busy', attention: null, lastPrompt: clip(input.prompt, 300) });
      case 'Stop':
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
      s.bgState = entry ? entry.state || entry.status : 'missing';
      if (!entry || ENDED.has(entry.state)) {
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
      // Attached and ready: Claude says it waits for input, or the attach client drew
      // its screen and has been quiet for 3 s.
      if (['starting', 'detached'].includes(s.state) && this.pty.isLive(`s:${s.id}`)) {
        const quiet = now() - (this.lastOutput.get(`s:${s.id}`) || now()) > 3000;
        if (entry.state === 'blocked' || quiet) { this.set(s, { state: 'idle' }); continue; }
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
      if (s.open && s.bgId && s.state !== 'closed') {
        if (!['busy', 'needs-you'].includes(s.state)) s.state = 'detached';
        this.attach(s);
      }
    }
    for (const h of this.state.shells) if (h.open) this.startShell(h);
    this.changed();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.pollTimer);
    store.flush();
  }
}

module.exports = { Manager, modelDisplay };
