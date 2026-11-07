'use strict';
// Cowork bridge, polycli side: links (a Cowork task paired with a workstream), turns
// (a prompt from Cowork delivered into a CLI session, and its answer) and artifacts.
// Cowork never opens, closes or restarts sessions: the user manages them in polycli. The pipe server in bridge.js calls `handle(op, args)`.
//
// Everything a Cowork task sends is untrusted: prompts are delivered only after the
// user approves them (or the workstream's policy allows it), always with a line saying
// where they come from, and never with input-mode prefixes unless approved one by one.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { transcriptTail } = require('./sessions');
const { tildify } = require('./paths');
const store = require('./store');

const now = () => Date.now();
const LINK_TTL_MS = 10 * 60000;          // a pending link expires after 10 minutes
const MAX_WAIT_S = 35;                   // Cowork's relay fails calls at 60 s
const LINK_WAIT_S = 25;
const MAX_TEXT = 20000;
const MAX_RESPONSE = 64 * 1024;
const KEEP_TURNS = 300;
const KEEP_ARTIFACTS = 1000;
const TYPING_QUIET_MS = 5000;            // don't paste while the user types in the pane
const SETTLE_QUIET_MS = 1500;            // pane quiet this long after idle-without-Stop: the turn ended
const MODE_PREFIX = /^\s*[!/#@]/;        // Claude input modes: bash, command, memory, file

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const rid = (p, n = 6) => p + crypto.randomBytes(n).toString('hex');
const clip = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) : s) : '');
const str = (v, n, what) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new Error(`${what} must be text`);
  if (v.length > n) throw new Error(`${what} is too long (max ${n} characters)`);
  return v;
};
const TERMINAL = new Set(['done', 'failed', 'rejected']);

class Cowork extends EventEmitter {
  constructor(manager) {
    super();
    this.m = manager;
    const st = manager.state;
    st.cowork = st.cowork || {};
    this.c = st.cowork;
    for (const k of ['links', 'turns', 'artifacts']) this.c[k] = this.c[k] || [];
    delete this.c.requests;   // open-session requests, from before 0.2.0
    this.waiters = new Set();
    this.delivering = new Set();          // session ids with a paste in progress
    this.stuck = new Map();               // session id → { at, seq } after a paste that was never submitted
    this.settling = new Set();            // turn ids being checked after an idle without Stop
    // A turn that was being pasted when polycli stopped may or may not have landed.
    for (const t of this.c.turns) if (t.state === 'delivering') this.finish(t, 'failed', { reason: 'polycli stopped while delivering this prompt' }, false);
    manager.on('session-hook', (s, event, input) => this.onHook(s, event, input));
    manager.on('session-state', (s, from, to) => this.onState(s, from, to));
    this.timer = setInterval(() => this.tick(), 1000);
  }
  dispose() { clearInterval(this.timer); for (const w of this.waiters) w(); }

  // ---------- state helpers ----------
  changed() { this.m.changed(); this.wake(); }
  wake() { for (const w of [...this.waiters]) w(); }
  // Resolves when anything changes or after `seconds`.
  waitChange(seconds) {
    return new Promise(resolve => {
      const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); };
      const t = setTimeout(done, Math.max(0, seconds) * 1000);
      this.waiters.add(done);
    });
  }
  async waitFor(pred, seconds) {
    const until = now() + Math.min(MAX_WAIT_S, Math.max(0, Number(seconds) || 0)) * 1000;
    for (;;) {
      const v = pred();
      if (v || now() >= until) return v;
      await this.waitChange((until - now()) / 1000);
    }
  }
  link(token) {
    if (typeof token !== 'string' || !token.startsWith('lnk_')) throw new Error('A link token from polycli_link is required');
    const l = this.c.links.find(x => x.tokenHash === sha(token));
    if (!l) throw new Error('Unknown link: call polycli_link again');
    this.expire();
    return l;
  }
  activeLink(token) {
    const l = this.link(token);
    if (l.state === 'pending') throw new Error('The link is still waiting for the user in polycli; poll polycli_link_status');
    if (l.state !== 'active') throw new Error(`The link is ${l.state}`);
    const w = this.ws(l.workstreamId);
    if (!w) throw new Error('The linked workstream no longer exists');
    if (w.archived) throw new Error('The linked workstream is archived in polycli; the user can restore it from the Archived list');
    return l;
  }
  expire() {
    let any = false;
    for (const l of this.c.links) if (l.state === 'pending' && now() - l.createdAt > LINK_TTL_MS) { l.state = 'expired'; l.decidedAt = now(); any = true; }
    if (any) this.changed();
  }
  ws(id) { return this.m.state.workstreams.find(w => w.id === id); }
  // A session of the linked workstream, by polycli id, full name or role.
  sessionFor(l, ref) {
    const r = String(ref || '').trim().toLowerCase();
    const list = this.m.state.sessions.filter(s => s.workstreamId === l.workstreamId);
    const s = list.find(x => x.id === ref) || list.find(x => x.name.toLowerCase() === r) || list.find(x => x.role.toLowerCase() === r);
    if (!s) throw new Error(`No session "${ref}" in workstream ${this.ws(l.workstreamId)?.name}. Use polycli_list to see the sessions.`);
    return s;
  }
  event(kind, data) { store.event(`cowork-${kind}`, data); }

  // ---------- views returned to Cowork ----------
  sessionView(s) {
    const g = this.m.snapshot().sessions.find(x => x.id === s.id) || s;
    return {
      session: s.name, role: s.role, state: s.state, attached: !!g.termLive, elsewhere: !!s.elsewhere,
      folder: g.cwdShort || tildify(s.cwd), model: s.header?.model || s.model || null, effort: s.header?.effort || s.effort || null,
      version: s.header?.version || null, branch: g.git?.branch || s.header?.branch || null,
    };
  }
  turnView(t) {
    const s = this.m.state.sessions.find(x => x.id === t.sessionId);
    let state = t.state;
    if (state === 'running' && s?.state === 'needs-you') state = 'needs-you';
    const v = { turn_id: t.id, session: s?.name || t.sessionName, state };
    if (state === 'awaiting-approval') v.note = 'Waiting for the user to approve this prompt in polycli.';
    if (state === 'queued') v.note = t.waitReason || 'Queued: delivered when the session is idle.';
    if (state === 'needs-you') v.note = 'Claude is waiting for the user (e.g. a permission prompt) in polycli. Keep polling polycli_read.';
    if (t.response !== undefined && t.response !== null) v.response = t.response;
    if (t.truncated) v.truncated = true;
    if (t.responseSource === 'transcript') v.note = 'The end of the turn was not observed directly (interrupted, or polycli was not running); the response is the last message in the transcript.';
    if (t.reason) v.reason = t.reason;
    if (t.files?.length) v.files_changed = t.files;
    if (t.endedAt) v.ended_at = new Date(t.endedAt).toISOString();
    return v;
  }

  // ---------- operations (from the pipe) ----------
  async handle(op, a) {
    a = a && typeof a === 'object' ? a : {};
    this.expire();
    switch (op) {
      case 'list': return this.opList(a);
      case 'link': return this.opLink(a);
      case 'link_status': return this.opLinkStatus(a);
      case 'send': return this.opSend(a);
      case 'read': return this.opRead(a);
      case 'status': return this.opStatus(a);
      case 'add_artifact': return this.opArtifact(a);
      default: throw new Error(`unknown operation ${op}`);
    }
  }

  opList(a) {
    const filter = String(a.workstream || '').trim().toLowerCase();
    return {
      workstreams: this.m.state.workstreams
        .filter(w => !w.archived && (!filter || w.name.toLowerCase() === filter))
        .map(w => ({
          workstream: w.name, folder: tildify(w.folder),
          sessions: this.m.state.sessions.filter(s => s.workstreamId === w.id && (s.open || s.state !== 'closed')).map(s => this.sessionView(s)),
          closed_sessions: this.m.state.sessions.filter(s => s.workstreamId === w.id && !s.open && s.state === 'closed').map(s => s.name),
        })),
    };
  }

  opLink(a) {
    const title = str(a.task_title, 200, 'task_title').trim();
    if (!title) throw new Error('task_title is required');
    if (this.c.mutedUntil && now() < this.c.mutedUntil) {
      return { state: 'muted', note: `The user muted link requests until ${new Date(this.c.mutedUntil).toISOString()}. Try again later.` };
    }
    const want = String(a.workstream || '').trim().toLowerCase();
    const w = want ? this.m.state.workstreams.find(x => !x.archived && x.name.toLowerCase() === want) : null;
    const token = 'lnk_' + crypto.randomBytes(16).toString('hex');
    const l = { id: rid('L', 4), tokenHash: sha(token), title, requested: a.workstream ? String(a.workstream).slice(0, 100) : null, workstreamId: w?.id || null, state: 'pending', createdAt: now(), sessions: [] };
    this.c.links.push(l);
    this.event('link-request', { link: l.id, title });
    this.emit('attention', { kind: 'link', title });
    this.changed();
    return { link: token, state: 'pending', expires_in_seconds: LINK_TTL_MS / 1000, note: 'Keep this link token for the rest of the task. The user approves it in polycli; poll polycli_link_status (at most every 10 s).' };
  }

  async opLinkStatus(a) {
    const l = this.link(a.link);
    const wait = Math.min(LINK_WAIT_S, Math.max(0, Number(a.wait_seconds ?? LINK_WAIT_S)));
    await this.waitFor(() => (this.expire(), l.state !== 'pending'), wait);
    const out = { state: l.state };
    if (l.state === 'active') {
      const w = this.ws(l.workstreamId);
      out.workstream = w?.name;
      out.sessions = this.m.state.sessions.filter(s => s.workstreamId === l.workstreamId && s.open).map(s => s.name);
    }
    return out;
  }

  // Prompt text from Cowork: CRLF normalized; any other control character (ESC in
  // particular, which could end the bracketed paste early) is rejected, not stripped.
  checkText(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');
    const t = text.replace(/\r\n?/g, '\n');
    if (t.length > MAX_TEXT) throw new Error(`text is too long (max ${MAX_TEXT} characters)`);
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(t)) throw new Error('text contains control characters');
    return t;
  }

  async opSend(a) {
    const l = this.activeLink(a.link);
    const s = this.sessionFor(l, a.session);
    const ref = str(a.client_ref, 200, 'client_ref').trim();
    if (!ref) throw new Error('client_ref is required (any unique string per prompt; reuse it when retrying)');
    let t = this.c.turns.find(x => x.linkId === l.id && x.clientRef === ref);
    if (!t) {
      const text = this.checkText(a.text);
      if (!s.open || s.state === 'closed') throw new Error(`Session ${s.name} is closed. Ask the user to reopen it in polycli.`);
      const w = this.ws(s.workstreamId);
      const ask = (w.coworkSend || 'ask') !== 'allow' || MODE_PREFIX.test(text);
      t = { id: rid('t_'), linkId: l.id, sessionId: s.id, sessionName: s.name, clientRef: ref, text, state: ask ? 'awaiting-approval' : 'queued', approvedBy: ask ? null : 'policy', createdAt: now(), files: [] };
      this.c.turns.push(t);
      if (!l.sessions.includes(s.id)) l.sessions.push(s.id);
      this.trim();
      this.event('turn', { turn: t.id, link: l.id, session: s.id, state: t.state, chars: text.length });
      if (ask) this.emit('attention', { kind: 'turn', title: l.title, session: s.name });
      this.changed();
    }
    await this.waitFor(() => TERMINAL.has(t.state), a.wait_seconds ?? 30);
    return this.turnView(t);
  }

  async opRead(a) {
    const l = this.link(a.link);
    const t = this.c.turns.find(x => x.id === a.turn_id && x.linkId === l.id);
    if (!t) throw new Error('Unknown turn_id for this link');
    const start = JSON.stringify(this.turnView(t));
    await this.waitFor(() => TERMINAL.has(t.state) || JSON.stringify(this.turnView(t)) !== start, a.wait_seconds ?? 30);
    return this.turnView(t);
  }

  opStatus(a) {
    const l = this.activeLink(a.link);
    const s = this.sessionFor(l, a.session);
    const pending = this.c.turns.filter(t => t.sessionId === s.id && !TERMINAL.has(t.state)).map(t => ({ turn_id: t.id, state: this.turnView(t).state, mine: t.linkId === l.id }));
    return { ...this.sessionView(s), turns: pending };
  }

  opArtifact(a) {
    const l = this.activeLink(a.link);
    const title = str(a.title, 300, 'title').trim();
    if (!title) throw new Error('title is required');
    const url = str(a.url, 2000, 'url').trim();
    if (url && !/^https:\/\//i.test(url)) throw new Error('url must be an https:// link');
    const p = str(a.path, 1000, 'path').trim();
    if (!url && !p) throw new Error('give a url or a path');
    const art = { id: rid('a_', 4), linkId: l.id, workstreamId: l.workstreamId, title, kind: str(a.kind, 50, 'kind').trim() || 'document', url: url || null, path: p || null, description: str(a.description, 1000, 'description').trim() || null, at: now() };
    this.c.artifacts.push(art);
    if (this.c.artifacts.length > KEEP_ARTIFACTS) this.c.artifacts.splice(0, this.c.artifacts.length - KEEP_ARTIFACTS);
    this.event('artifact', { link: l.id, artifact: art.id });
    this.changed();
    return { artifact_id: art.id, workstream: this.ws(l.workstreamId)?.name };
  }

  // ---------- decisions from the user (IPC, after a click) ----------
  decide({ kind, id, decision, workstreamId, text }) {
    if (kind === 'link') {
      const l = this.c.links.find(x => x.id === id && x.state === 'pending');
      if (!l) throw new Error('This link request is no longer pending');
      if (decision === 'approve') {
        const w = this.ws(workstreamId || l.workstreamId);
        if (!w) throw new Error('Choose a workstream');
        if (w.archived) throw new Error(`${w.name} is archived; restore it first`);
        Object.assign(l, { state: 'active', workstreamId: w.id, decidedAt: now() });
      } else Object.assign(l, { state: 'rejected', decidedAt: now() });
      this.event('link-decision', { link: l.id, decision });
    } else if (kind === 'turn') {
      const t = this.c.turns.find(x => x.id === id && x.state === 'awaiting-approval');
      if (!t) throw new Error('This prompt is no longer waiting for approval');
      if (decision === 'approve') {
        if (typeof text === 'string' && text !== t.text) t.text = this.checkText(text), t.edited = true;
        Object.assign(t, { state: 'queued', approvedBy: 'user' });
      } else this.finish(t, 'rejected', { reason: 'The user rejected this prompt in polycli' }, false);
      this.event('turn-decision', { turn: t.id, decision });
    } else throw new Error('unknown decision');
    this.changed();
  }
  rejectAllLinks() {
    for (const l of this.c.links) if (l.state === 'pending') Object.assign(l, { state: 'rejected', decidedAt: now() });
    this.changed();
  }
  mute(minutes) {
    this.c.mutedUntil = now() + Math.min(240, Math.max(1, Number(minutes) || 15)) * 60000;
    this.rejectAllLinks();
  }
  revoke(id) {
    const l = this.c.links.find(x => x.id === id);
    if (!l) throw new Error('unknown link');
    Object.assign(l, { state: 'revoked', decidedAt: now() });
    for (const t of this.c.turns) if (t.linkId === l.id && ['awaiting-approval', 'queued'].includes(t.state)) this.finish(t, 'rejected', { reason: 'The link was revoked' }, false);
    this.event('link-revoked', { link: l.id });
    this.changed();
  }

  // ---------- delivery ----------
  // Prompts go in one at a time per session, only when it is idle, attached in polycli
  // and nobody typed in the pane for a few seconds.
  tick() {
    this.expire();
    for (const t of this.c.turns) {
      if (t.state !== 'queued' || this.delivering.has(t.sessionId)) continue;
      const s = this.m.state.sessions.find(x => x.id === t.sessionId);
      if (!s) { this.finish(t, 'failed', { reason: 'The session was deleted' }); continue; }
      if (!s.open || s.state === 'closed') { this.finish(t, 'failed', { reason: 'The session was closed' }); continue; }
      const busy = this.c.turns.some(x => x.sessionId === s.id && ['delivering', 'running'].includes(x.state));
      const st = this.stuck.get(s.id);
      if (st && ((s.promptSeq || 0) !== st.seq || (this.m.lastInput.get(`s:${s.id}`) || 0) > st.at)) this.stuck.delete(s.id);
      const why = s.elsewhere ? 'Waiting: the session is attached in another terminal.'
        : busy ? 'Waiting for the previous prompt in this session to finish.'
        : this.stuck.has(s.id) ? 'Waiting: an earlier Cowork prompt may still be in the input box. Submit or clear it in the pane.'
        : s.state !== 'idle' ? `Waiting for the session to be idle (now ${s.state}).`
        : !this.m.pty.isLive(`s:${s.id}`) ? 'Waiting for polycli to attach the session.'
        : now() - (this.m.lastInput.get(`s:${s.id}`) || 0) < TYPING_QUIET_MS ? 'Waiting: the user is typing in this session.'
        : null;
      if (why) { if (t.waitReason !== why) { t.waitReason = why; this.changed(); } continue; }
      this.deliver(s, t);
    }
  }

  async deliver(s, t) {
    this.delivering.add(s.id);
    t.state = 'delivering';
    t.waitReason = null;
    const prefix = this.prefixFor(t, t.approvedBy);
    this.changed();
    try {
      const ok = await this.m.pasteAndSubmit(s, [prefix, t.text]);
      // The text may be left in the input box: hold this session's next prompts until
      // something is submitted or the user types in the pane.
      if (!ok) this.stuck.set(s.id, { at: now(), seq: s.promptSeq || 0 });
      // The submit can still be reported late; give it a while before giving up.
      if (!ok) setTimeout(() => { if (t.state === 'delivering') this.finish(t, 'failed', { reason: 'Claude did not receive the prompt (no submit seen)' }); }, 20000);
    } catch (e) {
      if (t.state === 'delivering') this.finish(t, 'failed', { reason: `Could not deliver: ${e.message || e}` });
    } finally {
      this.delivering.delete(s.id);
      this.changed();
    }
  }

  // The first line typed before a relayed prompt, as the user's own input: Claude treats
  // a long paste as quoted content and would not act on it otherwise. Fixed wording
  // only: nothing chosen by the Cowork task (such as its title) goes in this line.
  prefixFor(t, approvedBy) {
    const l = this.c.links.find(x => x.id === t.linkId);
    const how = approvedBy === 'policy' ? 'allowed by my polycli policy for this workstream' : 'approved by me in polycli';
    return `[polycli ${t.id}] Request relayed from a Cowork task linked to this workstream (link ${l?.id || '?'}, ${how}). Please handle it:`;
  }

  current(s) { return this.c.turns.find(t => t.sessionId === s.id && ['delivering', 'running'].includes(t.state)); }

  onHook(s, event, input) {
    const t = this.current(s);
    if (!t) return;
    if (event === 'UserPromptSubmit') {
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      if (t.state === 'delivering' && prompt.includes(`[polycli ${t.id}]`)) {
        Object.assign(t, { state: 'running', startedAt: now() });
        this.event('turn-running', { turn: t.id });
      } else if (t.state === 'delivering') {
        // Someone submitted their own text first; ours may be mixed into the box.
        this.finish(t, 'failed', { reason: 'Text typed in the pane was submitted while this prompt was being delivered; it was not sent' });
      }
      this.changed();
    } else if (event === 'PostToolUse' && t.state === 'running') {
      const f = input.tool_input?.file_path;
      if (typeof f === 'string' && !t.files.includes(f) && t.files.length < 200) t.files.push(f);
    } else if (event === 'Stop' && t.state === 'running') {
      this.finish(t, 'done', { response: input.last_assistant_message ?? this.lastText(s, t) });
    }
  }

  onState(s, _from, to) {
    const t = this.current(s);
    // A closed or reattached session has a fresh input box: nothing is left in it.
    if (to === 'closed' || to === 'starting') this.stuck.delete(s.id);
    if (to === 'closed') {
      for (const x of this.c.turns) if (x.sessionId === s.id && !TERMINAL.has(x.state) && x.state !== 'awaiting-approval') this.finish(x, 'failed', { reason: 'The session ended' });
      return;
    }
    // Busy or needs-you → idle without Stop: interrupted (Esc doesn't fire Stop, also at
    // a permission prompt) or polycli missed it. Settle once the pane has been quiet for
    // a moment: while Claude still works its spinner keeps drawing.
    if (t && t.state === 'running' && to === 'idle' && !this.settling.has(t.id)) {
      this.settling.add(t.id);
      const check = () => {
        if (t.state !== 'running' || s.state !== 'idle') return this.settling.delete(t.id);
        if (now() - (this.m.lastOutput.get(`s:${s.id}`) || 0) < SETTLE_QUIET_MS) return setTimeout(check, SETTLE_QUIET_MS);
        this.settling.delete(t.id);
        const text = this.lastText(s, t);
        if (text) this.finish(t, 'done', { response: text, responseSource: 'transcript' });
        else this.finish(t, 'failed', { reason: 'The turn ended without a response (interrupted in polycli?)' });
      };
      setTimeout(check, SETTLE_QUIET_MS);
    }
    this.wake();
  }

  // The last assistant text in the transcript, if written after the turn started.
  lastText(s, t) {
    if (!s.transcriptPath) return null;
    const a = transcriptTail(s.transcriptPath);
    if (!a || !a.timestamp || Date.parse(a.timestamp) < (t.startedAt || t.createdAt)) return null;
    const parts = Array.isArray(a.message?.content) ? a.message.content.filter(c => c.type === 'text').map(c => c.text) : [];
    return parts.join('\n').trim() || null;
  }

  finish(t, state, extra = {}, notify = true) {
    Object.assign(t, extra, { state, endedAt: now() });
    if (typeof t.response === 'string' && t.response.length > MAX_RESPONSE) { t.response = t.response.slice(0, MAX_RESPONSE); t.truncated = true; }
    this.event('turn-end', { turn: t.id, state, reason: t.reason || null });
    if (notify) this.changed();
  }

  trim() {
    if (this.c.turns.length <= KEEP_TURNS) return;
    const old = this.c.turns.filter(t => TERMINAL.has(t.state)).slice(0, this.c.turns.length - KEEP_TURNS);
    const drop = new Set(old.map(t => t.id));
    this.c.turns = this.c.turns.filter(t => !drop.has(t.id));
  }

  // ---------- for the renderer (no tokens, no hashes) ----------
  snapshot() {
    const pendingLinks = this.c.links.filter(l => l.state === 'pending').map(l => ({ id: l.id, title: l.title, requested: l.requested, workstreamId: l.workstreamId, createdAt: l.createdAt }));
    const linkTitle = id => this.c.links.find(l => l.id === id)?.title || '';
    return {
      mutedUntil: this.c.mutedUntil && this.c.mutedUntil > now() ? this.c.mutedUntil : null,
      pendingLinks,
      links: this.c.links.filter(l => l.state === 'active' || l.state === 'revoked').map(l => ({ id: l.id, title: l.title, workstreamId: l.workstreamId, state: l.state, createdAt: l.createdAt, sessions: l.sessions })),
      approvals: this.c.turns.filter(t => t.state === 'awaiting-approval').map(t => ({ kind: 'turn', id: t.id, linkTitle: linkTitle(t.linkId), sessionId: t.sessionId, sessionName: t.sessionName, firstLine: this.prefixFor(t, 'user'), text: t.text, forced: MODE_PREFIX.test(t.text), createdAt: t.createdAt })),
      turns: this.c.turns.slice(-60).map(t => ({ id: t.id, linkTitle: linkTitle(t.linkId), sessionId: t.sessionId, sessionName: t.sessionName, state: t.state, text: clip(t.text, 400), response: clip(t.response || '', 400), reason: t.reason || null, waitReason: t.waitReason || null, createdAt: t.createdAt, endedAt: t.endedAt || null })),
      artifacts: this.c.artifacts.slice(-300).map(a => ({ ...a, linkTitle: linkTitle(a.linkId) })),
    };
  }
}

module.exports = { Cowork, MAX_WAIT_S };
