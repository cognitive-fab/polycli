// polycli renderer: workstream rail, tabs, panes with session headers, xterm.js terminals.
import { Terminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';

const api = window.polycli;
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#7c8cf8', '#4cc38a', '#f2b84b', '#f06a6a', '#5aa9ff', '#c38af2', '#4cc3c3', '#e08a5a'];

let S = { workstreams: [], sessions: [], shells: [], ui: {}, plan: null };
const terms = new Map();          // term id → { term, fit, el, ro }
const showClosed = new Set();      // workstream ids with the Closed list expanded

const STATE_LABEL = {
  starting: 'Starting', idle: 'Idle', busy: 'Working', 'needs-you': 'Needs you', detached: 'Detached',
  closed: 'Closed', failed: 'Failed', untrusted: 'Trust needed',
};
const WORST = ['needs-you', 'failed', 'untrusted', 'busy', 'starting', 'detached', 'idle', 'closed'];

// ---------------- helpers ----------------
async function call(op, args) {
  try { return await api.call(op, args); }
  catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method 'polycli': (Error: )?/, ''), true); throw e; }
}
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, err ? 6000 : 2500);
}
function copyText(text, label) {
  call('copyText', { text }).then(() => toast(label || `Copied ${text.length} character${text.length === 1 ? '' : 's'}`));
}
const activeWs = () => S.workstreams.find(w => w.id === S.ui.activeWorkstream) || null;
const sessionsOf = wid => S.sessions.filter(s => s.workstreamId === wid);
const shellsOf = wid => S.shells.filter(h => h.workstreamId === wid);
const isOpenSession = s => s.open || s.termLive || s.trustLive;
function wsState(wid) {
  const st = sessionsOf(wid).filter(isOpenSession).map(s => s.state);
  if (shellsOf(wid).some(h => h.state === 'running')) st.push('idle');
  return WORST.find(x => st.includes(x)) || 'closed';
}
function tabsOf(wid) {
  const tabs = [];
  for (const s of sessionsOf(wid)) if (isOpenSession(s)) tabs.push({ id: `s:${s.id}`, label: s.role, state: s.state, kind: 'claude', rec: s });
  for (const h of shellsOf(wid)) tabs.push({ id: `h:${h.id}`, label: h.name, state: h.state === 'running' ? 'idle' : 'closed', kind: 'shell', rec: h });
  return tabs;
}

// ---------------- render ----------------
// ---------------- theme ----------------
// System / Light / Dark, saved in ui.theme. Terminals switch with the app.
const XTERM_THEMES = {
  dark: { background: '#101217', foreground: '#e4e7ee', cursor: '#7c8cf8', cursorAccent: '#101217', selectionBackground: '#7c8cf855' },
  light: {
    background: '#fbfbfd', foreground: '#1d2330', cursor: '#4f5fd6', cursorAccent: '#fbfbfd', selectionBackground: '#4f5fd640',
    black: '#1d2330', red: '#c4322f', green: '#23803f', yellow: '#8a6100', blue: '#2f62c8', magenta: '#9b38ad', cyan: '#127f8a', white: '#6b7383',
    brightBlack: '#4f5868', brightRed: '#d9443f', brightGreen: '#2e9450', brightYellow: '#a07200', brightBlue: '#3d74e0', brightMagenta: '#b04cc4', brightCyan: '#1a929e', brightWhite: '#3a4150',
  },
};
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
let currentTheme = 'dark';
const THEME_LABEL = { system: '◐ System', light: '☀ Light', dark: '☾ Dark' };
function applyTheme() {
  const pref = S.ui.theme || 'system';
  const resolved = pref === 'system' ? (systemDark.matches ? 'dark' : 'light') : pref;
  $('#themeBtn').textContent = THEME_LABEL[pref];
  if (resolved === currentTheme && document.documentElement.dataset.theme === resolved) return;
  currentTheme = resolved;
  document.documentElement.dataset.theme = resolved;
  for (const t of terms.values()) t.term.options.theme = XTERM_THEMES[resolved];
}
systemDark.addEventListener('change', () => applyTheme());

function render() {
  applyTheme();
  const ws = activeWs();
  $('#topTitle').textContent = ws ? `${ws.name} · ${ws.folderShort || ws.folder}` : '';
  renderInbox();
  renderRail();
  renderTabs();
  renderPanes();
  const none = !S.workstreams.length;
  $('#empty').hidden = !none;
  $('#tabs').hidden = none;
  $('#panes').hidden = none;
  if (none) $('#empty').innerHTML = `<div><h2>No workstreams yet</h2><p>A workstream groups the Claude sessions, shells and folders of one piece of work.</p><button class="btn primary" id="emptyAdd">Create a workstream</button></div>`;
  if (none) $('#emptyAdd').onclick = newWorkstreamDialog;
}

function renderInbox() {
  const waiting = S.sessions.filter(s => s.state === 'needs-you');
  $('#inboxCount').textContent = waiting.length;
  $('#inboxBtn').classList.toggle('hot', waiting.length > 0);
  $('#inboxMenu').innerHTML = waiting.length
    ? waiting.map(s => `<button class="inbox-item" data-tab="s:${s.id}"><b>${esc(s.name)}</b><small>${esc(s.attention?.message || '')}</small></button>`).join('')
    : `<div class="inbox-item"><small>Nothing is waiting on you.</small></div>`;
}

function renderRail() {
  const html = S.workstreams.map(w => {
    const active = w.id === S.ui.activeWorkstream;
    const st = wsState(w.id);
    let body = '';
    if (active) {
      const open = sessionsOf(w.id).filter(isOpenSession);
      const closed = sessionsOf(w.id).filter(s => !isOpenSession(s));
      const sel = S.ui.activeTab;
      body = `<div class="ws-body">
        ${open.map(s => `<button class="item st-${s.state} ${sel === `s:${s.id}` || sel === `t:${s.id}` ? 'sel' : ''}" data-tab="s:${s.id}" title="${esc(STATE_LABEL[s.state] || s.state)}"><span class="dot"></span><span class="label">${esc(s.role)}</span><span class="kind">claude</span></button>`).join('')}
        ${shellsOf(w.id).map(h => `<button class="item ${h.state === 'running' ? 'st-idle' : 'st-closed'} ${sel === `h:${h.id}` ? 'sel' : ''}" data-tab="h:${h.id}"><span class="dot"></span><span class="label">${esc(h.name)}</span><span class="kind">shell</span></button>`).join('')}
        ${closed.length ? `<button class="item closed-toggle" data-closed="${w.id}">${showClosed.has(w.id) ? '▾' : '▸'} Closed (${closed.length})</button>` : ''}
        ${showClosed.has(w.id) ? closed.map(s => `<button class="item st-${s.state}" data-reopen="${s.id}" title="Reopen"><span class="dot"></span><span class="label">${esc(s.role)}</span><span class="kind">${s.state === 'failed' ? 'failed' : 'reopen'}</span></button>`).join('') : ''}
        <div class="ws-actions">
          <button class="chip" data-act="newClaude">+ Claude</button>
          <button class="chip" data-act="newShell">+ Shell</button>
          <button class="chip" data-act="wsCode" title="Open the workstream folder in VS Code">VS Code</button>
          <button class="chip" data-act="wsSettings" title="Name, color, environment variables and the global keys this workstream uses">⚙ Settings${(w.env || []).length ? ` · ${w.env.length} var${w.env.length === 1 ? '' : 's'}` : ''}</button>
        </div>
      </div>`;
    }
    return `<div class="ws ${active ? 'active' : ''}" data-ws="${w.id}">
      <button class="ws-row st-${st}" data-select-ws="${w.id}"><span class="ws-color" style="background:${esc(w.color)}"></span><span class="ws-name">${esc(w.name)}</span><span class="dot"></span></button>
      ${body}
    </div>`;
  }).join('');
  $('#wsList').innerHTML = html;
}

function renderTabs() {
  const ws = activeWs();
  if (!ws) { $('#tabs').innerHTML = ''; return; }
  const tabs = tabsOf(ws.id);
  const active = currentTab(tabs);
  $('#tabs').innerHTML = tabs.map(t => `<button class="tab ${t.id === active ? 'active' : ''} st-${t.state}" data-tab="${t.id}"><span class="dot"></span>${esc(t.label)}<span class="x" data-close="${t.id}" title="${t.kind === 'claude' ? 'Close (the conversation is kept)' : 'Close shell'}">✕</span></button>`).join('');
}

function currentTab(tabs) {
  let sel = S.ui.activeTab || '';
  if (sel.startsWith('t:')) sel = 's:' + sel.slice(2);
  return tabs.some(t => t.id === sel) ? sel : tabs[0]?.id || null;
}

// Git line: branch, sync with upstream, local changes, GitHub repo and PR, and the
// Commit / Push / Deploy actions. Commit and Push wait while Claude is working.
function gitLine(s) {
  const g = s.git;
  if (!g) return '';
  const working = ['busy', 'needs-you'].includes(s.state);
  const wait = working ? ' disabled title="Claude is working in this session; wait until it is idle"' : '';
  const n = g.changed + g.untracked;
  const parts = [`<span class="branch">⎇ ${g.detached ? 'detached HEAD' : esc(g.branch)}</span>`];
  if (g.detached) { /* no upstream to compare with */ }
  else if (!g.upstream) parts.push('<span class="ab">not published</span>');
  else if (g.ahead || g.behind) parts.push(`<span class="ab" title="${g.ahead} to push, ${g.behind} to pull (${esc(g.upstream)})">↑${g.ahead} ↓${g.behind}</span>`);
  else parts.push(`<span class="ab ok" title="In sync with ${esc(g.upstream)}">synced</span>`);
  parts.push(n ? `<span class="chg">● ${n} changed</span>` : '<span class="ab">clean</span>');
  if (g.conflicts) parts.push(`<span class="bad">${g.conflicts} conflict${g.conflicts === 1 ? '' : 's'}</span>`);
  if (g.repo) parts.push(`<button class="link" data-act="gh-repo" title="Open on GitHub">${esc(g.repo)}</button>`);
  if (g.pr) {
    const c = g.pr.checks;
    const checks = c.fail ? ` <span class="bad">✗ ${c.fail}</span>` : c.pending ? ` <span class="pending">● ${c.pending}</span>` : c.pass ? ` <span class="ok">✓ ${c.pass}</span>` : '';
    parts.push(`<button class="link" data-act="gh-pr" title="${esc(g.pr.title)}">PR #${esc(g.pr.number)} ${esc(String(g.pr.state).toLowerCase())}</button>${checks}`);
  }
  const acts = [];
  if (n) acts.push(`<button class="chip" data-act="git-commit"${wait}>Commit</button>`);
  if (g.branch && (!g.upstream || g.ahead)) acts.push(`<button class="chip" data-act="git-push"${wait}>${g.upstream ? 'Push' : 'Publish'}</button>`);
  if (s.deploy) acts.push(`<button class="chip" data-act="deploy" title="${esc(s.deploy.command)}">Deploy</button>`);
  acts.push('<button class="chip icon" data-act="git-refresh" title="Refresh git and pull request info">↻</button>');
  return `<div class="l4">${parts.join('<span class="sep">·</span>')}<span class="git-acts">${acts.join('')}</span></div>`;
}

function headerLines(s) {
  const h = s.header || {};
  const version = h.version ? `Claude Code v${esc(h.version)}` : 'Claude Code';
  const model = h.model || (s.model ? s.model[0].toUpperCase() + s.model.slice(1) : 'Default model');
  const effort = h.effort ? ` with ${esc(h.effort)} effort` : '';
  const plan = S.plan ? ` · ${esc(S.plan)}` : '';
  return `<div class="banner-lines">
    <div class="l1">${version}</div>
    <div class="l2">${esc(model)}${effort}${plan}</div>
    <div class="l3"><button class="cwd" data-act="code" title="Open in VS Code (Shift: git root, Ctrl: new window)${s.liveCwd ? `&#10;Started in ${esc(s.startedShort)}` : ''}">${esc(s.cwdShort)}</button>${s.worktree ? `<span class="wt" title="The session moved into this git worktree; started in ${esc(s.startedShort)}">worktree</span>` : ''}${!s.git && h.branch ? `<span class="branch">⎇ ${esc(h.branch)}</span>` : ''}${s.bgId ? `<button class="sid" data-act="copy-id" title="Copy &quot;claude attach ${esc(s.bgId)}&quot; to continue in any terminal. That terminal takes the session over; Take back returns it here.">⧉ ${esc(s.bgId)}</button>` : ''}</div>
    ${gitLine(s)}
  </div>`;
}

function noticeFor(s) {
  if (s.state === 'untrusted') return `<div class="notice warn"><span class="grow">This folder isn't trusted by Claude Code yet. Answer the trust prompt below, then type <b>/exit</b>; polycli starts the session right after.</span>${s.trustLive ? '' : '<button class="btn" data-act="retrust">Show trust prompt</button>'}</div>`;
  if (s.state === 'needs-you') return `<div class="notice warn"><span class="grow">${esc(s.attention?.message || 'Claude needs your attention')}</span></div>`;
  if (s.elsewhere && !s.termLive) return `<div class="notice info"><span class="grow">Attached in another terminal (<code>claude attach ${esc(s.bgId)}</code>). The session keeps running there.</span><button class="btn" data-act="reopen">Take back</button></div>`;
  const w = S.workstreams.find(x => x.id === s.workstreamId);
  if (w && s.state !== 'closed' && (s.envRev || 0) !== (w.envRev || 0)) return `<div class="notice info"><span class="grow">The workstream's environment variables changed. Restart the session to apply them (the conversation is kept).</span><button class="btn" data-act="restart">⟳ Restart</button></div>`;
  if (s.state === 'failed') return `<div class="notice err"><span class="grow">${esc(s.error || 'The session failed to start.')}</span><button class="btn" data-act="restart">Try again</button></div>`;
  if (s.state === 'detached' && !s.termLive) return `<div class="notice info"><span class="grow">Detached. The session keeps running in the background.</span><button class="btn" data-act="reopen">Reattach</button></div>`;
  if (s.error) return `<div class="notice err"><span class="grow">${esc(s.error)}</span></div>`;
  return '';
}

function renderPanes() {
  const ws = activeWs();
  const panes = $('#panes');
  const tabs = ws ? tabsOf(ws.id) : [];
  const active = currentTab(tabs);
  const wanted = new Set();
  for (const t of tabs) {
    let pane = panes.querySelector(`.pane[data-tab="${t.id}"]`);
    if (!pane) {
      pane = document.createElement('section');
      pane.className = 'pane';
      pane.dataset.tab = t.id;
      pane.innerHTML = `<div class="pane-top"></div><div class="term"></div>`;
      panes.appendChild(pane);
    }
    wanted.add(t.id);
    pane.hidden = t.id !== active;
    const top = pane.querySelector('.pane-top');
    let termId = t.id;
    if (t.kind === 'claude') {
      const s = t.rec;
      const trust = s.trustLive || (s.state === 'untrusted');
      termId = trust ? `t:${s.id}` : `s:${s.id}`;
      top.innerHTML = `<div class="pane-head">${headerLines(s)}
        <div class="pane-actions">
          <span class="state-pill st-${s.state}"><span class="dot"></span>${esc(STATE_LABEL[s.state] || s.state)}</span>
          <button class="btn" data-act="code" title="Open the session folder in VS Code (Shift: git root, Ctrl: new window)">VS Code</button>
          <button class="btn" data-act="restart" title="Restart: same conversation, current Claude Code version and settings">⟳ Restart</button>
          <button class="btn" data-act="close" title="Close: stops the session, the conversation is kept">✕ Close</button>
          <button class="btn danger" data-act="delete" title="Delete the session and its conversation">Delete</button>
        </div></div>${noticeFor(s)}`;
      top.dataset.session = s.id;
      const live = trust ? s.trustLive : s.termLive;
      showTerm(pane, termId, live || terms.has(termId), live ? '' : s.elsewhere ? 'Attached in another terminal.' : s.state === 'starting' ? 'Starting the session…' : s.state === 'closed' ? 'Closed. Reopen it from the Closed list.' : 'Not attached.');
    } else {
      const h = t.rec;
      const hw = S.workstreams.find(x => x.id === h.workstreamId);
      const stale = hw && h.state === 'running' && (h.envRev || 0) !== (hw.envRev || 0);
      top.innerHTML = `<div class="notice info"><span class="grow">${esc(h.command)} · <button class="cwd btn" data-act="code-shell" style="font-family:var(--mono)">${esc(h.cwdShort)}</button>${stale ? ' · environment variables changed; open a new shell to get them' : ''}</span>${h.state !== 'running' ? '<button class="btn" data-act="restart-shell">Restart shell</button>' : ''}</div>`;
      top.dataset.shell = h.id;
      showTerm(pane, termId, true, '');
    }
  }
  for (const pane of [...panes.querySelectorAll('.pane')]) if (!wanted.has(pane.dataset.tab)) pane.remove();
  let hint = panes.querySelector('.pane-empty');
  if (ws && !tabs.length) {
    if (!hint) { hint = document.createElement('div'); hint.className = 'pane pane-empty placeholder'; panes.appendChild(hint); }
    const closed = sessionsOf(ws.id).length;
    hint.innerHTML = `<div><p>Nothing open in ${esc(ws.name)}.</p><p><button class="btn primary" data-act="newClaude">+ Claude session</button> <button class="btn" data-act="newShell">+ Shell</button></p>${closed ? '<p>Closed sessions are listed in the rail; click one to reopen it.</p>' : ''}</div>`;
  } else {
    hint?.remove();
  }
  for (const [id, t] of terms) if (!document.body.contains(t.el)) { t.ro.disconnect(); t.term.dispose(); terms.delete(id); }
  requestAnimationFrame(() => {
    for (const t of terms.values()) if (t.el.offsetParent) { fitTerm(t); }
    const vis = [...terms.values()].find(t => t.el.offsetParent);
    if (vis && !document.querySelector('.modal-back:not([hidden])') && !document.activeElement?.closest?.('.inbox-menu')) vis.term.focus();
  });
}

function showTerm(pane, termId, live, placeholder) {
  const host = pane.querySelector('.term');
  let ph = pane.querySelector('.placeholder');
  if (!live) {
    host.hidden = true;
    if (!ph) { ph = document.createElement('div'); ph.className = 'placeholder'; pane.appendChild(ph); }
    ph.textContent = placeholder;
    return;
  }
  ph?.remove();
  host.hidden = false;
  if (host.dataset.term === termId) return;
  // The pane switched terminals (trust prompt → session): drop the xterm it showed
  // before, and any stale one for the new id, then start a fresh xterm.
  for (const id of new Set([host.dataset.term, termId])) {
    const old = id && terms.get(id);
    if (old) { old.ro.disconnect(); old.term.dispose(); terms.delete(id); }
  }
  host.innerHTML = '';
  host.dataset.term = termId;
  mountTerm(host, termId);
}

function mountTerm(host, termId) {
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace', fontSize: 13, cursorBlink: true,
    scrollback: 5000, allowProposedApi: true,
    theme: XTERM_THEMES[currentTheme],
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  const t = { term, fit, el: host, ro: null, ready: false, queue: [] };
  terms.set(termId, t);
  term.onData(d => api.write(termId, d));
  // Copy and paste work like Windows Terminal: drag selects, Ctrl+C copies when there
  // is a selection (otherwise it goes to the session as usual), Ctrl+Shift+C never
  // reaches the session. Pasting is left to the browser's paste event, which xterm
  // turns into one bracketed paste; handling Ctrl+V here as well pasted twice.
  term.attachCustomKeyEventHandler(e => {
    if (!e.ctrlKey || e.altKey) return true;
    const k = e.key.toLowerCase();
    if (k === 'v') return false;
    if (k === 'c' && (e.shiftKey || term.hasSelection())) {
      if (e.type === 'keydown' && term.hasSelection()) { copyText(term.getSelection()); term.clearSelection(); }
      return false;
    }
    return true;
  });
  if (!termId.startsWith('h:')) keepSelectionLocal(term);
  // OSC 52: a program in the terminal sets the clipboard. Writes only; requests to
  // read the clipboard are ignored, and so is the scrollback replayed on mount.
  term.parser.registerOscHandler(52, data => {
    const b64 = data.slice(data.indexOf(';') + 1);
    if (!t.replayed || !b64 || b64 === '?') return true;
    try {
      const text = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
      if (text) copyText(text);
    } catch {}
    return true;
  });
  t.ro = new ResizeObserver(() => fitTerm(t));
  t.ro.observe(host);
  api.call('scrollback', { term: termId }).then(buf => {
    if (terms.get(termId) !== t) return;   // replaced or disposed meanwhile
    if (buf) term.write(buf);
    for (const d of t.queue) term.write(d);
    term.write('', () => { t.replayed = true; });
    t.queue = null; t.ready = true;
    fitTerm(t);
  });
  t.id = termId;
}

// Claude Code turns on mouse reporting. xterm then hands every drag to Claude instead
// of selecting, so Ctrl+C found no selection, reached Claude and cleared the prompt.
// In Claude panes polycli keeps mouse reporting off (drag selects, as in a plain
// terminal) and still forwards the wheel, so Claude's transcript scrolls.
const MOUSE_MODES = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);
function keepSelectionLocal(term) {
  let tracking = false, sgr = false;
  const num = p => (Array.isArray(p) ? p[0] : p);
  const track = final => params => {
    const mouse = params.filter(p => MOUSE_MODES.has(num(p)));
    if (!mouse.length) return false;
    const on = final === 'h';
    for (const p of mouse) {
      if ([1000, 1002, 1003].includes(num(p))) tracking = on;
      if (num(p) === 1006) sgr = on;
    }
    // Mouse modes are swallowed, so xterm never enters mouse mode; any other modes in
    // the same sequence (e.g. CSI ? 1000;2004 h) are passed on.
    const rest = params.filter(p => !MOUSE_MODES.has(num(p)));
    if (rest.length) term.write(`\x1b[?${rest.map(p => [].concat(p).join(':')).join(';')}${final}`);
    return true;
  };
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, track('h'));
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, track('l'));
  // Wheel reports are sent in SGR encoding (what Claude Code asks for); for any other
  // encoding the wheel keeps xterm's default behavior.
  term.attachCustomWheelEventHandler(e => {
    if (!tracking || !sgr || e.shiftKey || !e.deltaY) return true;
    const r = term.element.querySelector('.xterm-screen').getBoundingClientRect();
    const col = Math.min(term.cols, Math.max(1, Math.ceil((e.clientX - r.left) / (r.width / term.cols))));
    const row = Math.min(term.rows, Math.max(1, Math.ceil((e.clientY - r.top) / (r.height / term.rows))));
    const lines = Math.max(1, Math.min(5, Math.round(Math.abs(e.deltaY) / 40)));
    term.input(`\x1b[<${e.deltaY < 0 ? 64 : 65};${col};${row}M`.repeat(lines), false);
    e.preventDefault();
    return false;
  });
}

function fitTerm(t) {
  if (!t.el.offsetParent) return;
  try {
    t.fit.fit();
    const key = `${t.term.cols}x${t.term.rows}`;
    if (key !== t.lastSize) { t.lastSize = key; api.resize(t.id, t.term.cols, t.term.rows); }
  } catch {}
}

// ---------------- dialogs ----------------
function modal(html, onSubmit, { wide = false } = {}) {
  const back = $('#modalBack'), form = $('#modal');
  form.innerHTML = html + `<div class="error" id="modalErr"></div>`;
  form.classList.toggle('wide', wide);
  form.classList.remove('help-modal');
  back.hidden = false;
  const close = () => { back.hidden = true; form.onsubmit = null; };
  let busy = false;
  form.onsubmit = async e => {
    e.preventDefault();
    if (busy) return;   // a double click or a repeated Enter submits once
    busy = true;
    const submit = form.querySelector('.modal-actions .primary');
    if (submit) submit.disabled = true;
    try { await onSubmit(new FormData(form), form); close(); }
    catch (err) { $('#modalErr').textContent = String(err.message || err).replace(/^Error invoking remote method 'polycli': (Error: )?/, ''); }
    finally { busy = false; if (submit) submit.disabled = false; }
  };
  form.querySelector('[data-cancel]').onclick = close;
  back.onkeydown = e => { if (e.key === 'Escape') close(); };
  setTimeout(() => form.querySelector('input,select')?.focus(), 0);
  return form;
}

function browseButton(form, inputName) {
  form.querySelector(`[data-browse="${inputName}"]`).onclick = async () => {
    const input = form.querySelector(`[name="${inputName}"]`);
    const p = await call('pickFolder', { defaultPath: input.value || undefined });
    if (p) input.value = p;
  };
}

function newWorkstreamDialog() {
  let color = COLORS[S.workstreams.length % COLORS.length];
  const form = modal(`<h3>New workstream</h3>
    <label class="field"><span>Name</span><input name="name" placeholder="polygraph-paper" maxlength="60" required></label>
    <label class="field"><span>Main folder</span><div class="row"><input name="folder" placeholder="C:\\Users\\you\\code\\repo" required><button type="button" class="btn" data-browse="folder" style="flex:none">Browse…</button></div></label>
    <div class="field"><span>Color</span><div class="swatches">${COLORS.map(c => `<button type="button" class="swatch ${c === color ? 'sel' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}</div></div>
    <div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Create</button></div>`,
  async fd => { await call('createWorkstream', { name: fd.get('name'), folder: fd.get('folder').trim(), color }); });
  browseButton(form, 'folder');
  form.querySelectorAll('[data-color]').forEach(b => b.onclick = () => {
    color = b.dataset.color;
    form.querySelectorAll('.swatch').forEach(x => x.classList.toggle('sel', x === b));
  });
}

function newSessionDialog(ws) {
  const n = sessionsOf(ws.id).length + 1;
  const form = modal(`<h3>New Claude session in ${esc(ws.name)}</h3>
    <label class="field"><span>Role (names the session "${esc(ws.name)} · role")</span><input name="role" value="${n === 1 ? 'main' : 'session ' + n}" maxlength="60" required></label>
    <label class="field"><span>Folder</span><div class="row"><input name="cwd" value="${esc(ws.folder)}" required><button type="button" class="btn" data-browse="cwd" style="flex:none">Browse…</button></div></label>
    <div class="row">
      <label class="field"><span>Model</span><select name="model"><option value="">Default</option><option value="opus">Opus</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option></select></label>
      <label class="field"><span>Effort</span><select name="effort"><option value="">Default</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option></select></label>
    </div>
    <div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Start session</button></div>`,
  async fd => {
    await api.call('newSession', { workstreamId: ws.id, role: fd.get('role'), cwd: fd.get('cwd').trim(), model: fd.get('model'), effort: fd.get('effort') });
  });
  browseButton(form, 'cwd');
}

const BILLING_VARS = /^(ANTHROPIC_|CLAUDE_CODE_USE_)/i;

// Workstream settings: name, color, environment variables (stored encrypted, values
// never shown again) and the global keys this workstream relies on.
async function wsSettingsDialog(ws) {
  let color = ws.color;
  const globals = await call('globalKeys').catch(() => []);
  const uses = new Set(ws.uses || []);
  const envRow = (name = '', existing = false) => `<div class="env-row" ${existing ? 'data-existing="1"' : ''}>
      <input class="env-name" value="${esc(name)}" placeholder="NAME" spellcheck="false" ${existing ? 'readonly title="Remove and add again to rename"' : ''}>
      <input class="env-value" type="password" autocomplete="off" placeholder="${existing ? 'saved · type to replace' : 'value'}">
      <button type="button" class="btn env-del" title="Remove">✕</button>
    </div>`;
  const form = modal(`<h3>${esc(ws.name)} · settings</h3>
    <div class="row">
      <label class="field"><span>Name</span><input name="name" value="${esc(ws.name)}" maxlength="60" required></label>
      <div class="field" style="flex:none"><span>Color</span><div class="swatches">${COLORS.map(c => `<button type="button" class="swatch ${c === color ? 'sel' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}</div></div>
    </div>
    <div class="field"><span>Environment variables for this workstream</span>
      <div id="envRows">${(ws.env || []).map(e => envRow(e.name, true)).join('')}</div>
      <div><button type="button" class="btn" id="envAdd">+ Add variable</button></div>
      <div class="hint" id="envWarn"></div>
      <div class="hint">Every Claude session and new shell in this workstream gets them, on top of your Windows variables (a workstream value wins). Values are stored encrypted for your Windows account and are not shown again. When a session starts they are written into its settings file under %APPDATA%\\polycli\\run, which Claude reads. Running sessions pick up changes on Restart.</div>
    </div>
    <label class="field"><span>Deploy command (runs in a new shell tab from the Deploy button; leave empty to use a package.json "deploy" script if there is one)</span><input name="deploy" value="${esc(ws.deploy || '')}" placeholder="npm run deploy" spellcheck="false" style="font-family:var(--mono)"></label>
    <div class="field"><span>Global keys this workstream uses (for your own tracking; every session already has them)</span>
      <div class="key-checks">${globals.length ? globals.map(g => `<label class="key-check"><input type="checkbox" name="uses" value="${esc(g.name)}" ${uses.has(g.name) ? 'checked' : ''}><code>${esc(g.name)}</code>${g.scope === 'machine' ? '<small>machine</small>' : ''}</label>`).join('') : '<span class="hint">No key-like Windows variables found.</span>'}</div>
    </div>
    <div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div>`,
  async (fd, f) => {
    const env = [...f.querySelectorAll('.env-row')].map(r => {
      const name = r.querySelector('.env-name').value.trim();
      const value = r.querySelector('.env-value').value;
      return r.dataset.existing && !value ? { name } : { name, value };
    }).filter(e => e.name || e.value);
    await api.call('updateWorkstream', { id: ws.id, name: fd.get('name'), color, env, uses: fd.getAll('uses'), deploy: fd.get('deploy') });
    toast('Workstream saved');
  }, { wide: true });
  const rows = form.querySelector('#envRows');
  const warn = () => {
    const names = [...rows.querySelectorAll('.env-name')].map(i => i.value.trim()).filter(n => BILLING_VARS.test(n));
    form.querySelector('#envWarn').innerHTML = names.length ? `<span class="warn-text">${names.map(esc).join(', ')} change${names.length === 1 ? 's' : ''} how Claude itself signs in and bills (an API key here moves this workstream off your Claude plan).</span>` : '';
  };
  form.querySelector('#envAdd').onclick = () => { rows.insertAdjacentHTML('beforeend', envRow()); rows.lastElementChild.querySelector('.env-name').focus(); };
  rows.addEventListener('click', e => { if (e.target.closest('.env-del')) { e.target.closest('.env-row').remove(); warn(); } });
  rows.addEventListener('input', warn);
  warn();
  form.querySelectorAll('[data-color]').forEach(b => b.onclick = () => {
    color = b.dataset.color;
    form.querySelectorAll('.swatch').forEach(x => x.classList.toggle('sel', x === b));
  });
}

// Global keys: the key-like variables saved in Windows (names only), which workstreams
// say they use, and which workstreams set their own value.
async function keysDialog() {
  const globals = await call('globalKeys');
  const usedBy = n => S.workstreams.filter(w => (w.uses || []).includes(n));
  const setIn = n => S.workstreams.filter(w => (w.env || []).some(e => e.name.toUpperCase() === n.toUpperCase()));
  const chips = ws => ws.map(w => `<span class="ws-chip"><span class="ws-color" style="background:${esc(w.color)}"></span>${esc(w.name)}</span>`).join('');
  const local = S.workstreams.flatMap(w => (w.env || []).map(e => ({ w, name: e.name }))).filter(x => !globals.some(g => g.name.toUpperCase() === x.name.toUpperCase()));
  const form = modal(`<h3>Keys</h3>
    <div class="hint" style="margin-bottom:10px">Key-like variables saved in Windows (names only). Every Claude session and shell gets them. Mark which workstreams use each one in the workstream's ⚙ Settings.</div>
    <table class="keys-table"><thead><tr><th>Variable</th><th>Used by</th><th>Own value in</th></tr></thead><tbody>
      ${globals.map(g => { const u = usedBy(g.name), o = setIn(g.name); return `<tr><td><code>${esc(g.name)}</code>${g.scope === 'machine' ? ' <small>machine</small>' : ''}</td><td>${u.length ? chips(u) : '<span class="hint">not assigned</span>'}</td><td>${chips(o)}</td></tr>`; }).join('') || '<tr><td colspan="3" class="hint">No key-like Windows variables found.</td></tr>'}
    </tbody></table>
    ${local.length ? `<h3 style="margin-top:16px">Workstream-only variables</h3><table class="keys-table"><tbody>${local.map(x => `<tr><td><code>${esc(x.name)}</code></td><td>${chips([x.w])}</td></tr>`).join('')}</tbody></table>` : ''}
    <div class="modal-actions"><button type="button" class="btn" data-cancel hidden></button><button class="btn primary">Close</button></div>`,
  async () => {}, { wide: true });
  form.querySelector('.btn.primary').focus();
}

async function commitDialog(s) {
  const st = await call('gitFiles', { id: s.id });
  const canAsk = s.termLive && s.state === 'idle';
  const form = modal(`<h3>Commit in ${esc(st.rootShort || s.cwdShort)}</h3>
    <div class="file-list">${st.files.map(f => `<div><code class="x">${esc(f.x)}</code> ${esc(f.path)}</div>`).join('') || '<div class="hint">No changes.</div>'}</div>
    <label class="key-check" style="margin:8px 0 10px"><input type="checkbox" name="all" checked> Stage all changes (git add -A)</label>
    <label class="field"><span>Message</span><textarea name="message" rows="4" placeholder="What changed and why"></textarea></label>
    <div class="modal-actions">${canAsk ? '<button type="button" class="btn" data-ask style="margin-right:auto" title="Claude writes the message and commits">Ask Claude to commit</button>' : ''}<button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Commit</button></div>`,
  async fd => {
    const out = await api.call('commitSession', { id: s.id, message: fd.get('message'), all: fd.get('all') === 'on' });
    toast(out.split('\n')[0] || 'Committed');
  }, { wide: true });
  const ask = form.querySelector('[data-ask]');
  if (ask) ask.onclick = async () => { $('#modalBack').hidden = true; form.onsubmit = null; await call('askClaudeCommit', { id: s.id }); toast('Asked Claude to commit'); };
}

function pushDialog(s) {
  const g = s.git;
  const what = g.upstream
    ? `Push ${g.ahead} commit${g.ahead === 1 ? '' : 's'} from <code>${esc(g.branch)}</code> to <code>${esc(g.upstream)}</code>?`
    : `Publish <code>${esc(g.branch)}</code> to <code>origin</code> (git push -u origin HEAD)?`;
  const behind = g.behind ? `<p class="warn-text">The remote has ${g.behind} commit${g.behind === 1 ? '' : 's'} you don't have, so the push will be rejected. Pull first.</p>` : '';
  const form = modal(`<h3>${g.upstream ? 'Push' : 'Publish branch'}</h3><p>${what}</p>${behind}
    <div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">${g.upstream ? 'Push' : 'Publish'}</button></div>`,
  async () => {
    const out = await api.call('pushSession', { id: s.id });
    toast(out.split('\n').filter(Boolean).pop() || 'Pushed');
  });
  form.querySelector('.btn.primary').focus();
}

function deployDialog(s) {
  const d = s.deploy;
  const form = modal(`<h3>Deploy</h3>
    <p>Run <code>${esc(d.command)}</code> in <code>${esc(d.cwdShort)}</code>?</p>
    <p class="hint">${d.detected ? 'Found as the "deploy" script in package.json. ' : ''}It runs in a new shell tab of this workstream, with its environment variables. Set or change the command in the workstream's ⚙ Settings.</p>
    <div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Run</button></div>`,
  async () => { await api.call('deploySession', { id: s.id }); });
  form.querySelector('.btn.primary').focus();
}

// ---------------- help ----------------
// resources/help/HELP.md is the single source (GitHub shows it too). This renders the
// subset it uses: headings, paragraphs, lists, bold, inline code and images that are
// plain file names next to it. Everything is escaped first.
function mdInline(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<i>$2</i>');
}
function markdown(src) {
  const out = [];
  let list = null, para = [];
  const flush = () => {
    if (para.length) { out.push(`<p>${mdInline(para.join(' '))}</p>`); para = []; }
    if (list) { out.push(`</${list}>`); list = null; }
  };
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = /^(#{1,3}) (.*)$/.exec(line))) { flush(); out.push(`<h${m[1].length + 2}>${mdInline(m[2])}</h${m[1].length + 2}>`); continue; }
    if ((m = /^!\[([^\]]*)\]\(([\w.-]+\.png)\)$/.exec(line))) { flush(); out.push(`<img class="help-img" alt="${esc(m[1])}" src="../../resources/help/${m[2]}">`); continue; }
    if ((m = /^(- |\d+\. )(.*)$/.exec(line))) {
      if (para.length) { out.push(`<p>${mdInline(para.join(' '))}</p>`); para = []; }
      const tag = m[1] === '- ' ? 'ul' : 'ol';
      if (list !== tag) { if (list) out.push(`</${list}>`); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${mdInline(m[2])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list}>`); list = null; }
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}
async function helpDialog() {
  const md = await call('helpText');
  const form = modal(`<div class="help">${markdown(md)}</div>
    <div class="modal-actions"><button type="button" class="btn" data-cancel hidden></button><button class="btn primary">Close</button></div>`,
  async () => {}, { wide: true });
  form.classList.add('help-modal');
  form.scrollTop = 0;
  form.querySelector('.btn.primary').focus({ preventScroll: true });
}

// ---------------- events ----------------
function openVSCode(args, e) {
  call('openVSCode', { ...args, root: !!e?.shiftKey, mode: e?.ctrlKey ? 'new' : 'reuse' }).then(() => toast('Opening VS Code…'));
}

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-close],[data-tab],[data-select-ws],[data-act],[data-reopen],[data-closed]');
  if (!el) {
    if (!e.target.closest('.inbox-menu')) $('#inboxMenu').hidden = true;
    return;
  }
  if (el.dataset.close) {
    e.stopPropagation();
    const [kind, id] = el.dataset.close.split(':');
    if (kind === 's') await call('closeSession', { id });
    else await call('closeShell', { id });
    return;
  }
  if (el.dataset.tab) {
    $('#inboxMenu').hidden = true;
    const id = el.dataset.tab.slice(2);
    const s = S.sessions.find(x => x.id === id) || S.shells.find(x => x.id === id);
    if (s && s.workstreamId !== S.ui.activeWorkstream) await call('setActive', { id: s.workstreamId });
    S.ui.activeTab = el.dataset.tab;
    await call('setUi', { activeTab: el.dataset.tab });
    return;
  }
  if (el.dataset.selectWs) { await call('setActive', { id: el.dataset.selectWs }); return; }
  if (el.dataset.reopen) { await call('reopenSession', { id: el.dataset.reopen }); return; }
  if (el.dataset.closed) {
    showClosed.has(el.dataset.closed) ? showClosed.delete(el.dataset.closed) : showClosed.add(el.dataset.closed);
    render();
    return;
  }
  const act = el.dataset.act;
  const ws = activeWs();
  const sid = el.closest('[data-session]')?.dataset.session;
  const hid = el.closest('[data-shell]')?.dataset.shell;
  if (act === 'newClaude' && ws) return newSessionDialog(ws);
  if (act === 'newShell' && ws) return call('newShell', { workstreamId: ws.id });
  if (act === 'wsCode' && ws) return openVSCode({ workstreamId: ws.id }, e);
  if (act === 'wsSettings' && ws) return wsSettingsDialog(ws);
  if (act === 'code' && sid) return openVSCode({ sessionId: sid }, e);
  if (act === 'code-shell' && hid) return openVSCode({ shellId: hid }, e);
  if (act === 'restart-shell' && hid) return call('restartShell', { id: hid });
  if (act === 'close' && sid) return call('closeSession', { id: sid });
  if (act === 'reopen' && sid) return call('reopenSession', { id: sid });
  const ses = sid && S.sessions.find(x => x.id === sid);
  if (act === 'git-commit' && ses) return commitDialog(ses);
  if (act === 'git-push' && ses?.git) return pushDialog(ses);
  if (act === 'deploy' && ses?.deploy) return deployDialog(ses);
  if (act === 'git-refresh' && ses) return call('refreshGit', { id: sid }).then(() => toast('Git info refreshed'));
  if (act === 'gh-repo' && ses?.git?.repo) return call('openGithub', { url: `https://github.com/${ses.git.repo}` });
  if (act === 'gh-pr' && ses?.git?.pr) return call('openGithub', { url: ses.git.pr.url });
  if (act === 'copy-id' && sid) { const s = S.sessions.find(x => x.id === sid); if (s?.bgId) copyText(`claude attach ${s.bgId}`, `Copied: claude attach ${s.bgId}`); return; }
  if ((act === 'restart' || act === 'retrust') && sid) return call('restartSession', { id: sid });
  if (act === 'delete' && sid) {
    const s = S.sessions.find(x => x.id === sid);
    const form = modal(`<h3>Delete “${esc(s?.name)}”?</h3><p style="color:var(--text-dim)">This stops the session and removes its background record. Use Close instead to keep the conversation.</p>
      <div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Delete</button></div>`,
    async () => { await call('deleteSession', { id: sid }); });
    form.querySelector('.btn.primary').focus();
  }
});

$('#addWs').onclick = newWorkstreamDialog;
$('#themeBtn').onclick = () => {
  const order = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(S.ui.theme || 'system') + 1) % order.length];
  S.ui.theme = next;
  applyTheme();
  call('setUi', { theme: next });
};
$('#keysBtn').onclick = () => keysDialog();
$('#helpBtn').onclick = () => helpDialog();
$('#inboxBtn').onclick = e => { e.stopPropagation(); $('#inboxMenu').hidden = !$('#inboxMenu').hidden; };

api.onState(s => { S = s; render(); });
api.onFocusTab(async tab => {
  const s = S.sessions.find(x => x.id === tab.slice(2));
  if (s) await call('setActive', { id: s.workstreamId });
  await call('setUi', { activeTab: tab });
});
api.onData((termId, data) => {
  const t = terms.get(termId);
  if (!t) return;
  if (t.ready) t.term.write(data); else t.queue.push(data);
});

call('state').then(s => { S = s; render(); });
window.__polycli = { get state() { return S; }, terms };
