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
const activeWs = () => S.workstreams.find(w => w.id === S.ui.activeWorkstream) || null;
const sessionsOf = wid => S.sessions.filter(s => s.workstreamId === wid);
const shellsOf = wid => S.shells.filter(h => h.workstreamId === wid);
const isOpenSession = s => s.open || s.termLive || s.trustLive;
function wsState(wid) {
  const st = sessionsOf(wid).filter(isOpenSession).map(s => s.state);
  return WORST.find(x => st.includes(x)) || 'closed';
}
function tabsOf(wid) {
  const tabs = [];
  for (const s of sessionsOf(wid)) if (isOpenSession(s)) tabs.push({ id: `s:${s.id}`, label: s.role, state: s.state, kind: 'claude', rec: s });
  for (const h of shellsOf(wid)) tabs.push({ id: `h:${h.id}`, label: h.name, state: h.state === 'running' ? 'idle' : 'closed', kind: 'shell', rec: h });
  return tabs;
}

// ---------------- render ----------------
function render() {
  const ws = activeWs();
  $('#topTitle').textContent = ws ? `${ws.name} · ${ws.folder}` : '';
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

function headerLines(s) {
  const h = s.header || {};
  const version = h.version ? `Claude Code v${esc(h.version)}` : 'Claude Code';
  const model = h.model || (s.model ? s.model[0].toUpperCase() + s.model.slice(1) : 'Default model');
  const effort = h.effort ? ` with ${esc(h.effort)} effort` : '';
  const plan = S.plan ? ` · ${esc(S.plan)}` : '';
  return `<div class="banner-lines">
    <div class="l1">${version}</div>
    <div class="l2">${esc(model)}${effort}${plan}</div>
    <div class="l3"><button class="cwd" data-act="code" title="Open in VS Code (Shift: git root, Ctrl: new window)">${esc(s.cwdShort)}</button>${h.branch ? `<span class="branch">⎇ ${esc(h.branch)}</span>` : ''}</div>
  </div>`;
}

function noticeFor(s) {
  if (s.state === 'untrusted') return `<div class="notice warn"><span class="grow">This folder isn't trusted by Claude Code yet. Answer the trust prompt below, then type <b>/exit</b>; polycli starts the session right after.</span>${s.trustLive ? '' : '<button class="btn" data-act="retrust">Show trust prompt</button>'}</div>`;
  if (s.state === 'needs-you') return `<div class="notice warn"><span class="grow">${esc(s.attention?.message || 'Claude needs your attention')}</span></div>`;
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
      showTerm(pane, termId, live || terms.has(termId), live ? '' : s.state === 'starting' ? 'Starting the session…' : s.state === 'closed' ? 'Closed. Reopen it from the Closed list.' : 'Not attached.');
    } else {
      const h = t.rec;
      top.innerHTML = `<div class="notice info"><span class="grow">${esc(h.command)} · <button class="cwd btn" data-act="code-shell" style="font-family:var(--mono)">${esc(h.cwdShort)}</button></span>${h.state !== 'running' ? '<button class="btn" data-act="restart-shell">Restart shell</button>' : ''}</div>`;
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
  // The pane switched terminals (trust prompt → session): start a fresh xterm.
  host.innerHTML = '';
  host.dataset.term = termId;
  const old = terms.get(termId);
  if (old) { old.ro.disconnect(); old.term.dispose(); terms.delete(termId); }
  mountTerm(host, termId);
}

function mountTerm(host, termId) {
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace', fontSize: 13, cursorBlink: true,
    scrollback: 5000, allowProposedApi: true,
    theme: { background: '#101217', foreground: '#e4e7ee', cursor: '#7c8cf8', selectionBackground: '#7c8cf855' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  const t = { term, fit, el: host, ro: null, ready: false, queue: [] };
  terms.set(termId, t);
  term.onData(d => api.write(termId, d));
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
    if (e.ctrlKey && k === 'v') { navigator.clipboard.readText().then(x => x && term.paste(x)); return false; }
    return true;
  });
  t.ro = new ResizeObserver(() => fitTerm(t));
  t.ro.observe(host);
  api.call('scrollback', { term: termId }).then(buf => {
    if (buf) term.write(buf);
    for (const d of t.queue) term.write(d);
    t.queue = null; t.ready = true;
    fitTerm(t);
  });
  t.id = termId;
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
function modal(html, onSubmit) {
  const back = $('#modalBack'), form = $('#modal');
  form.innerHTML = html + `<div class="error" id="modalErr"></div>`;
  back.hidden = false;
  const close = () => { back.hidden = true; form.onsubmit = null; };
  form.onsubmit = async e => {
    e.preventDefault();
    try { await onSubmit(new FormData(form), form); close(); }
    catch (err) { $('#modalErr').textContent = String(err.message || err).replace(/^Error invoking remote method 'polycli': (Error: )?/, ''); }
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
    const p = call('newSession', { workstreamId: ws.id, role: fd.get('role'), cwd: fd.get('cwd').trim(), model: fd.get('model'), effort: fd.get('effort') });
    await new Promise(r => setTimeout(r, 0));
    p.catch(() => {});
  });
  browseButton(form, 'cwd');
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
  if (act === 'code' && sid) return openVSCode({ sessionId: sid }, e);
  if (act === 'code-shell' && hid) return openVSCode({ shellId: hid }, e);
  if (act === 'restart-shell' && hid) return call('restartShell', { id: hid });
  if (act === 'close' && sid) return call('closeSession', { id: sid });
  if (act === 'reopen' && sid) return call('reopenSession', { id: sid });
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
