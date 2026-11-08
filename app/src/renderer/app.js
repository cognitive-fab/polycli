// polycli renderer: workstream rail, tabs, panes with session headers, xterm.js terminals.
import { Terminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { showProject, hideProject, isDirty } from './views.js';

const api = window.polycli;
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#7c8cf8', '#4cc38a', '#f2b84b', '#f06a6a', '#5aa9ff', '#c38af2', '#4cc3c3', '#e08a5a'];

let S = { workstreams: [], sessions: [], shells: [], ui: {}, plan: null };
const terms = new Map();          // term id → { term, fit, el, ro }
const showClosed = new Set();      // workstream ids with the Closed list expanded
let showArchived = false;           // the Archived list at the bottom of the rail is expanded

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
const liveWorkstreams = () => S.workstreams.filter(w => !w.archived);
const activeWs = () => liveWorkstreams().find(w => w.id === S.ui.activeWorkstream) || null;
const sessionsOf = wid => S.sessions.filter(s => s.workstreamId === wid);
const shellsOf = wid => S.shells.filter(h => h.workstreamId === wid);
const isOpenSession = s => s.open || s.termLive || s.trustLive;
// ✋ while a session of the workstream has put questions on screen and waits for the
// answers (the AskUserQuestion tool); it goes away when they are answered.
const wsAsking = wid => sessionsOf(wid).find(s => isOpenSession(s) && s.asking) || null;
const hand = s => `<span class="hand" title="${esc(s.name || 'A session')} is asking you a question${s.asking?.question ? ': ' + esc(s.asking.question) : ''}">✋</span>`;
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
  renderBilling();
  renderInbox();
  renderCowork();
  renderRail();
  renderTabs();
  renderPanes();
  const none = !liveWorkstreams().length;
  const view = ws && ['board', 'architecture', 'docs', 'tests'].includes(S.ui.view) ? S.ui.view : 'main';
  $('#viewbar').hidden = !ws;
  for (const b of document.querySelectorAll('#viewbar [data-view]')) b.classList.toggle('active', b.dataset.view === view);
  $('#empty').hidden = !none;
  $('#tabs').hidden = none || view !== 'main';
  $('#panes').hidden = none || view !== 'main';
  $('#project').hidden = view === 'main';
  if (view === 'main') hideProject();
  else showProject($('#project'), { ws, view, call, toast, ask, setView });
  if (none) $('#empty').innerHTML = S.workstreams.length
    ? `<div><h2>All workstreams are archived</h2><p>Restore one from the Archived list at the bottom of the left rail, or create a new one.</p><button class="btn primary" id="emptyAdd">Create a workstream</button></div>`
    : `<div><h2>No workstreams yet</h2><p>A workstream groups the Claude sessions, shells and folders of one piece of work.</p><button class="btn primary" id="emptyAdd">Create a workstream</button></div>`;
  if (none) $('#emptyAdd').onclick = newWorkstreamDialog;
}

// ---------------- time and tokens per folder ----------------
const fmtDur = sec => {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
};
const fmtTok = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const fmtHours = sec => (sec / 3600).toFixed(2);

// Topbar: this week's Claude generation time and output tokens for the selected
// workstream (resets Monday 07:00) and, on a billable one, my time this month.
function renderBilling() {
  const b = S.billing, btn = $('#billBtn');
  btn.hidden = !b;
  if (!b) return;
  const week = `(${fmtDur(b.weekGenSec)} · ↓ ${fmtTok(b.weekOut)} tokens)`;
  btn.classList.toggle('hot', b.running);
  btn.innerHTML = b.billable ? `<span class="inbox-dot"></span>⏱ ${fmtDur(b.monthSec)} ${esc(week)}` : esc(week);
  const wk = new Date(b.weekStart).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  btn.title = `${b.label}: this week since ${wk}, Claude generated for ${fmtDur(b.weekGenSec)} and wrote ${b.weekOut.toLocaleString()} output tokens.`
    + (b.billable ? `\nBillable: you today ${fmtDur(b.todaySec)}, this month ${fmtDur(b.monthSec)}; ${b.running ? 'counting now' : 'paused (not focused, idle, or Claude is generating)'}.` : '')
    + '\nClick for monthly totals.';
}

async function billingDialog() {
  const months = await call('billingHistory');
  const rows = months.map((M, i) => `<details ${i === 0 ? 'open' : ''}><summary><b>${esc(M.month)}</b><span class="bill-cols"><span>${fmtHours(M.total.bill)} h billable</span><span>${fmtDur(M.total.gen)} Claude</span><span>↓ ${fmtTok(M.total.out)}</span></span></summary>
      <table class="keys-table"><thead><tr><th>Workstream</th><th>Billable</th><th>Claude</th><th>Output tokens</th></tr></thead><tbody>
      ${M.rows.map(R => `<tr><td>${esc(R.label)}${R.billable ? '' : ' <small>not billable</small>'}</td><td>${fmtHours(R.bill)} h</td><td>${fmtDur(R.gen)}</td><td>${R.out.toLocaleString()}</td></tr>
        ${R.days.map(D => `<tr class="bill-day"><td>${esc(D.day)}</td><td>${fmtHours(D.bill)} h</td><td>${fmtDur(D.gen)}</td><td>${D.out.toLocaleString()}</td></tr>`).join('')}`).join('')}
      </tbody></table></details>`).join('');
  const form = modal(`<h3>Billing history</h3>
    <p class="hint">Billable = the time you worked on a billable workstream: it selected, polycli focused, you not idle for 5 minutes, and none of its Claude sessions generating. Claude time and output tokens come from the session transcripts. Mark a workstream billable in its settings.</p>
    <div class="bill-list">${rows || '<p class="hint">Nothing recorded yet.</p>'}</div>
    <div class="modal-actions"><button type="button" class="btn" id="billCsv" style="margin-right:auto">Copy CSV</button><button type="button" class="btn" data-cancel>Close</button></div>`, async () => {}, { wide: true });
  form.querySelector('#billCsv').onclick = () => {
    const csv = ['month,day,workstream,billable_hours,claude_seconds,output_tokens'];
    for (const M of months) for (const R of M.rows) for (const D of R.days) csv.push([M.month, D.day, `"${R.label.replace(/"/g, '""')}"`, fmtHours(D.bill), Math.round(D.gen), D.out].join(','));
    copyText(csv.join('\n'), 'Copied billing CSV');
  };
}

function renderInbox() {
  const waiting = S.sessions.filter(s => s.state === 'needs-you');
  const cw = S.cowork || { approvals: [], pendingLinks: [] };
  const n = waiting.length + cw.approvals.length + cw.pendingLinks.length;
  $('#inboxCount').textContent = n;
  $('#inboxBtn').classList.toggle('hot', n > 0);
  const items = [
    ...waiting.map(s => `<button class="inbox-item" data-tab="s:${s.id}"><b>${esc(s.name)}</b><small>${esc(s.attention?.message || '')}</small></button>`),
    ...cw.pendingLinks.map(l => `<div class="inbox-item"><b>Cowork link request</b><small>${esc(l.title)}: see the Cowork bar above the tabs</small></div>`),
    ...cw.approvals.map(a => `<div class="inbox-item"><b>${a.kind === 'turn' ? `Cowork prompt for ${esc(a.sessionName)}` : `Cowork wants a new session (${esc(a.role)})`}</b><small>${esc(a.linkTitle)}: see the Cowork bar above the tabs</small></div>`),
  ];
  $('#inboxMenu').innerHTML = items.length ? items.join('') : `<div class="inbox-item"><small>Nothing is waiting on you.</small></div>`;
}

// ---------------- Cowork bar: link requests and approvals ----------------
// Everything here comes from a Cowork task: escaped, shown in full, acted on only by a click.
function renderCowork() {
  const cw = S.cowork;
  const bar = $('#coworkStrip');
  if (!cw || (!cw.pendingLinks.length && !cw.approvals.length)) { bar.hidden = true; bar.innerHTML = ''; return; }
  // Don't redraw while the user is choosing in a select or editing.
  if (bar.contains(document.activeElement) && document.activeElement.matches('select, textarea')) return;
  const wsOptions = sel => liveWorkstreams().map(w => `<option value="${w.id}" ${w.id === sel ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
  const rows = [];
  const links = cw.pendingLinks;
  links.slice(0, 3).forEach(l => rows.push(`<div class="cw-row" data-cw-link="${l.id}">
      <span class="cw-tag">Cowork</span>
      <span class="grow">Task <b>${esc(l.title)}</b> wants to link to ${l.requested ? `workstream <b>${esc(l.requested)}</b>` : 'a workstream'}${l.requested && !l.workstreamId ? ' <span class="warn-text">(no workstream with that name)</span>' : ''}. Linking lets it send prompts to that workstream's sessions; each prompt still needs your approval unless you allow it.</span>
      <select class="cw-ws">${wsOptions(l.workstreamId || S.ui.activeWorkstream)}</select>
      <button class="btn primary" data-cw="link-approve">Link</button>
      <button class="btn" data-cw="link-reject">Reject</button>
    </div>`));
  if (links.length > 3) rows.push(`<div class="cw-row"><span class="grow">${links.length - 3} more link request${links.length - 3 === 1 ? '' : 's'}</span></div>`);
  if (links.length > 1) rows.push(`<div class="cw-row"><span class="grow"></span><button class="btn" data-cw="reject-all">Reject all requests</button><button class="btn" data-cw="mute">Mute requests for 15 min</button></div>`);
  for (const a of cw.approvals) {
    rows.push(`<div class="cw-row cw-approval" data-cw-turn="${a.id}">
      <span class="cw-tag">Cowork</span>
      <div class="grow"><div>Task <b>${esc(a.linkTitle)}</b> wants to send this prompt to <b>${esc(a.sessionName)}</b>${a.forced ? ' <span class="warn-text">(starts with a command character, so it always asks)</span>' : ''}:</div>
        <pre class="cw-text"><span class="cw-first">${esc(a.firstLine)}</span>
${esc(a.text)}</pre></div>
      <div class="cw-acts"><button class="btn primary" data-cw="turn-approve">Send</button><button class="btn" data-cw="turn-reject">Reject</button></div>
    </div>`);
  }
  bar.innerHTML = rows.join('');
  bar.hidden = false;
}

async function coworkClick(el) {
  const act = el.dataset.cw;
  const row = el.closest('.cw-row');
  if (act === 'reject-all') return call('coworkRejectAllLinks');
  if (act === 'mute') return call('coworkMute', { minutes: 15 }).then(() => toast('Cowork link requests muted for 15 minutes'));
  if (act.startsWith('link-')) return call('coworkDecide', { kind: 'link', id: row.dataset.cwLink, decision: act === 'link-approve' ? 'approve' : 'reject', workstreamId: row.querySelector('.cw-ws')?.value });
  if (act.startsWith('turn-')) return call('coworkDecide', { kind: 'turn', id: row.dataset.cwTurn, decision: act === 'turn-approve' ? 'approve' : 'reject' });
}

// The Cowork panel of a workstream: linked tasks, artifacts they reported, recent prompts.
function coworkDialog(ws) {
  const cw = S.cowork || { links: [], artifacts: [], turns: [] };
  const links = cw.links.filter(l => l.workstreamId === ws.id);
  const arts = cw.artifacts.filter(a => a.workstreamId === ws.id).slice().reverse();
  const sids = new Set(S.sessions.filter(s => s.workstreamId === ws.id).map(s => s.id));
  const turns = cw.turns.filter(t => sids.has(t.sessionId)).slice().reverse().slice(0, 20);
  const when = t => new Date(t).toLocaleString();
  const form = modal(`<h3>${esc(ws.name)} · Cowork</h3>
    <div class="field"><span>Linked Cowork tasks</span>
      ${links.length ? `<table class="keys-table"><tbody>${links.map(l => `<tr><td><b>${esc(l.title)}</b><br><small>${esc(when(l.createdAt))}</small></td><td>${l.state === 'active' ? '<span class="ok-text">active</span>' : esc(l.state)}</td><td style="text-align:right">${l.state === 'active' ? `<button type="button" class="btn" data-revoke="${l.id}">Revoke</button>` : ''}</td></tr>`).join('')}</tbody></table>`
        : '<div class="hint">No Cowork task is linked yet. In a Cowork task, ask it to use the polycli tools (polycli_link) for this workstream.</div>'}
      <div class="hint">Cowork reaches polycli through the <b>polycli bridge</b> extension of the Claude desktop app. <button type="button" class="btn" data-install>Install or update the extension…</button></div>
    </div>
    <div class="field"><span>Artifacts and documents reported by Cowork</span>
      ${arts.length ? `<table class="keys-table"><tbody>${arts.map(a => `<tr><td><b>${esc(a.title)}</b> <small>${esc(a.kind)}</small>${a.description ? `<br><small>${esc(a.description)}</small>` : ''}<br><small>${esc(a.linkTitle)} · ${esc(when(a.at))}</small></td><td style="text-align:right;white-space:nowrap">${a.url ? `<button type="button" class="btn" data-art="${a.id}" data-what="url" title="${esc(a.url)}">Open link</button>` : ''} ${a.path ? `<button type="button" class="btn" data-art="${a.id}" data-what="path" title="${esc(a.path)}">Show file</button>` : ''}</td></tr>`).join('')}</tbody></table>`
        : '<div class="hint">None yet.</div>'}
    </div>
    <div class="field"><span>Recent prompts from Cowork</span>
      ${turns.length ? `<table class="keys-table"><tbody>${turns.map(t => `<tr><td><small>${esc(t.sessionName)} · ${esc(t.linkTitle)}</small><br>${esc(t.text)}${t.response ? `<br><small>→ ${esc(t.response)}</small>` : ''}${t.reason ? `<br><small class="warn-text">${esc(t.reason)}</small>` : ''}</td><td>${esc(t.state)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="hint">None yet.</div>'}
    </div>
    <div class="modal-actions"><button type="button" class="btn" data-cancel hidden></button><button class="btn primary">Close</button></div>`,
  async () => {}, { wide: true });
  form.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => { await call('coworkRevoke', { id: b.dataset.revoke }); b.closest('tr').querySelector('td:nth-child(2)').textContent = 'revoked'; b.remove(); });
  form.querySelectorAll('[data-art]').forEach(b => b.onclick = () => call('openArtifact', { id: b.dataset.art, what: b.dataset.what }));
  form.querySelector('[data-install]').onclick = () => call('installBridge').then(() => toast('The Claude desktop app opens its install dialog'));
}

function renderRail() {
  const html = liveWorkstreams().map(w => {
    const active = w.id === S.ui.activeWorkstream;
    const st = wsState(w.id);
    let body = '';
    if (active) {
      const open = sessionsOf(w.id).filter(isOpenSession);
      const closed = sessionsOf(w.id).filter(s => !isOpenSession(s));
      const sel = S.ui.activeTab;
      body = `<div class="ws-body">
        ${open.map(s => `<button class="item st-${s.state} ${sel === `s:${s.id}` || sel === `t:${s.id}` ? 'sel' : ''}" data-tab="s:${s.id}" title="${esc(STATE_LABEL[s.state] || s.state)}"><span class="dot"></span><span class="label">${esc(s.role)}</span>${s.asking ? hand(s) : ''}<span class="kind">claude</span></button>`).join('')}
        ${shellsOf(w.id).map(h => `<button class="item ${h.state === 'running' ? 'st-idle' : 'st-closed'} ${sel === `h:${h.id}` ? 'sel' : ''}" data-tab="h:${h.id}"><span class="dot"></span><span class="label">${esc(h.name)}</span><span class="kind">shell</span></button>`).join('')}
        ${closed.length ? `<button class="item closed-toggle" data-closed="${w.id}">${showClosed.has(w.id) ? '▾' : '▸'} Closed (${closed.length})</button>` : ''}
        ${showClosed.has(w.id) ? closed.map(s => `<button class="item st-${s.state}" data-reopen="${s.id}" title="Reopen"><span class="dot"></span><span class="label">${esc(s.role)}</span><span class="kind">${s.state === 'failed' ? 'failed' : 'reopen'}</span></button>`).join('') : ''}
        <div class="ws-actions">
          <button class="chip" data-act="newClaude">+ Claude</button>
          <button class="chip" data-act="newShell">+ Shell</button>
          <button class="chip" data-act="newMistral" title="Mistral Vibe in a new tab (needs the vibe CLI and a Mistral key)">+ Mistral</button>
          <button class="chip" data-act="wsCode" title="Open the workstream folder in VS Code">VS Code</button>
          <button class="chip" data-act="wsCowork" title="Cowork tasks linked to this workstream, their artifacts and prompts">Cowork${(() => { const n = (S.cowork?.links || []).filter(l => l.workstreamId === w.id && l.state === 'active').length; return n ? ` · ${n}` : ''; })()}</button>
          <button class="chip" data-act="wsSettings" title="Name, color, environment variables and the global keys this workstream uses">⚙ Settings${(w.env || []).length ? ` · ${w.env.length} var${w.env.length === 1 ? '' : 's'}` : ''}</button>
        </div>
      </div>`;
    }
    return `<div class="ws ${active ? 'active' : ''}" data-ws="${w.id}">
      <button class="ws-row st-${st}" data-select-ws="${w.id}"><span class="ws-color" style="background:${esc(w.color)}"></span><span class="ws-name">${esc(w.name)}</span>${wsAsking(w.id) ? hand(wsAsking(w.id)) : ''}<span class="dot"></span></button>
      ${body}
    </div>`;
  }).join('');
  const archived = S.workstreams.filter(w => w.archived);
  const arch = archived.length ? `<div class="ws-archived">
      <button class="item closed-toggle" data-archived-toggle="1">${showArchived ? '▾' : '▸'} Archived (${archived.length})</button>
      ${showArchived ? archived.map(w => `<div class="ws-arch-row"><span class="ws-color" style="background:${esc(w.color)}"></span><span class="ws-name">${esc(w.name)}</span><button class="chip" data-restore-ws="${w.id}" title="Show it in the rail again; its sessions reopen from Closed">Restore</button></div>`).join('') : ''}
    </div>` : '';
  $('#wsList').innerHTML = html + arch;
}

function renderTabs() {
  const ws = activeWs();
  if (!ws) { $('#tabs').innerHTML = ''; return; }
  const tabs = tabsOf(ws.id);
  const active = currentTab(tabs);
  $('#tabs').innerHTML = tabs.map(t => `<button class="tab ${t.id === active ? 'active' : ''} st-${t.state}" data-tab="${t.id}"><span class="dot"></span>${esc(t.label)}${t.rec?.asking ? hand(t.rec) : ''}<span class="x" data-close="${t.id}" title="${t.kind === 'claude' ? 'Close (the conversation is kept)' : 'Close shell'}">✕</span></button>`).join('');
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
    <div class="l3"><button class="cwd" data-act="code" title="Open in VS Code (Shift: git root, Ctrl: new window)${s.liveCwd ? `&#10;Started in ${esc(s.startedShort)}` : ''}">${esc(s.cwdShort)}</button>${s.worktree ? `<span class="wt" title="The session moved into this git worktree; started in ${esc(s.startedShort)}">worktree</span>` : ''}${s.remote ? `<span class="wt" title="Remote Control is on: find &quot;${esc(s.name)}&quot; at claude.ai/code or in the Claude mobile app">remote</span>` : ''}${!s.git && h.branch ? `<span class="branch">⎇ ${esc(h.branch)}</span>` : ''}${s.bgId ? `<button class="sid" data-act="copy-id" title="Copy &quot;claude attach ${esc(s.bgId)}&quot; to continue in any terminal. That terminal takes the session over; Take back returns it here.">⧉ ${esc(s.bgId)}</button>` : ''}</div>
    ${gitLine(s)}
  </div>`;
}

function noticeFor(s) {
  if (s.state === 'untrusted') return `<div class="notice warn"><span class="grow">This folder isn't trusted by Claude Code yet. Answer the trust prompt below, then type <b>/exit</b>; polycli starts the session right after.</span>${s.trustLive ? '' : '<button class="btn" data-act="retrust">Show trust prompt</button>'}</div>`;
  if (s.state === 'needs-you') return `<div class="notice warn"><span class="grow">${esc(s.attention?.message || 'Claude needs your attention')}</span></div>`;
  if (s.elsewhere && !s.termLive) return `<div class="notice info"><span class="grow">Attached in another terminal (<code>claude attach ${esc(s.bgId)}</code>). The session keeps running there.</span><button class="btn" data-act="reopen">Take back</button></div>`;
  const cwTurn = (S.cowork?.turns || []).filter(t => t.sessionId === s.id && ['queued', 'delivering', 'running'].includes(t.state));
  if (cwTurn.length) {
    const t = cwTurn.find(x => x.state !== 'queued') || cwTurn[0];
    return `<div class="notice info"><span class="grow">◇ From Cowork (${esc(t.linkTitle)}): ${esc(t.text.split('\n')[0].slice(0, 160))}${t.state === 'queued' && t.waitReason ? ` · ${esc(t.waitReason)}` : ''}${cwTurn.length > 1 ? ` · ${cwTurn.length - 1} more queued` : ''}</span></div>`;
  }
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
      pane.innerHTML = t.kind === 'claude'
        ? `<div class="pane-top"></div><div class="pane-body"><div class="term"></div><aside class="prompts"></aside></div>`
        : `<div class="pane-top"></div><div class="term"></div>`;
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
      renderPrompts(pane, s);
      const live = trust ? s.trustLive : s.termLive;
      showTerm(pane, termId, live || terms.has(termId), live ? '' : s.elsewhere ? 'Attached in another terminal.' : s.state === 'starting' ? 'Starting the session…' : s.state === 'closed' ? 'Closed. Reopen it from the Closed list.' : 'Not attached.');
    } else {
      const h = t.rec;
      const hw = S.workstreams.find(x => x.id === h.workstreamId);
      const stale = hw && h.state === 'running' && (h.envRev || 0) !== (hw.envRev || 0);
      top.innerHTML = `<div class="notice info"><span class="grow">${esc(h.agent === 'mistral' ? 'Mistral Vibe (vibe)' : h.command)} ·<button class="cwd btn" data-act="code-shell" style="font-family:var(--mono)">${esc(h.cwdShort)}</button>${stale ? ' · environment variables changed; open a new shell to get them' : ''}</span>${h.state !== 'running' ? '<button class="btn" data-act="restart-shell">Restart shell</button>' : ''}</div>`;
      top.dataset.shell = h.id;
      showTerm(pane, termId, true, '');
    }
  }
  for (const pane of [...panes.querySelectorAll('.pane')]) if (!wanted.has(pane.dataset.tab)) pane.remove();
  let hint = panes.querySelector('.pane-empty');
  if (ws && !tabs.length) {
    if (!hint) { hint = document.createElement('div'); hint.className = 'pane pane-empty placeholder'; panes.appendChild(hint); }
    const closed = sessionsOf(ws.id).length;
    hint.innerHTML = `<div><p>Nothing open in ${esc(ws.name)}.</p><p><button class="btn primary" data-act="newClaude">+ Claude session</button> <button class="btn" data-act="newShell">+ Shell</button> <button class="btn" data-act="newMistral">+ Mistral</button></p>${closed ? '<p>Closed sessions are listed in the rail; click one to reopen it.</p>' : ''}</div>`;
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
  const t = { term, fit, el: host, ro: null, ready: false, queue: [], mouse: { tracking: false, sgr: false } };
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
  if (!termId.startsWith('h:')) keepSelectionLocal(term, t.mouse);
  pasteFilesAsPaths(host, term);
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

// Images and files go in as paths, the way a terminal does on drop: Claude attaches a
// pasted image path as [Image #n]. Files copied or dropped from Explorer give their own
// paths; an image with no file (a screenshot) is saved by polycli first. Text on the
// clipboard always wins, and pastes as usual.
function pasteFilesAsPaths(host, term) {
  const quote = p => (/\s/.test(p) ? `"${p}"` : p);
  const typePaths = list => { if (list.length) { term.paste(list.map(quote).join(' ')); term.focus(); } };
  host.addEventListener('paste', async e => {
    const dt = e.clipboardData;
    if (!dt || dt.getData('text/plain')) return;
    // Read everything now: the clipboard data is gone once the event returns.
    const files = [...dt.files];
    const paths = files.map(f => api.filePath(f)).filter(Boolean);
    const image = [...dt.items].find(i => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
    if (!paths.length && !image) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!paths.length) {
      try { paths.push(await call('savePastedImage', { data: new Uint8Array(await image.arrayBuffer()) })); } catch { return; }
    }
    typePaths(paths);
  }, true);
  host.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  host.addEventListener('drop', e => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    typePaths(files.map(f => api.filePath(f)).filter(Boolean));
  });
}

// Claude Code turns on mouse reporting. xterm then hands every drag to Claude instead
// of selecting, so Ctrl+C found no selection, reached Claude and cleared the prompt.
// In Claude panes polycli keeps mouse reporting off (drag selects, as in a plain
// terminal) and still forwards the wheel, so Claude's transcript scrolls.
const MOUSE_MODES = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);
function keepSelectionLocal(term, mouse) {
  const num = p => (Array.isArray(p) ? p[0] : p);
  const track = final => params => {
    const modes = params.filter(p => MOUSE_MODES.has(num(p)));
    if (!modes.length) return false;
    const on = final === 'h';
    for (const p of modes) {
      if ([1000, 1002, 1003].includes(num(p))) mouse.tracking = on;
      if (num(p) === 1006) mouse.sgr = on;
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
    if (!mouse.tracking || !mouse.sgr || e.shiftKey || !e.deltaY) return true;
    const r = term.element.querySelector('.xterm-screen').getBoundingClientRect();
    const col = Math.min(term.cols, Math.max(1, Math.ceil((e.clientX - r.left) / (r.width / term.cols))));
    const row = Math.min(term.rows, Math.max(1, Math.ceil((e.clientY - r.top) / (r.height / term.rows))));
    const lines = Math.max(1, Math.min(5, Math.round(Math.abs(e.deltaY) / 40)));
    term.input(`\x1b[<${e.deltaY < 0 ? 64 : 65};${col};${row}M`.repeat(lines), false);
    e.preventDefault();
    return false;
  });
}

// ---------------- prompt list at the right of a Claude pane ----------------
// The prompts sent to the session (main records them from UserPromptSubmit). Hover
// shows the whole prompt; a click scrolls Claude's transcript to it.
const promptCache = new Map();   // session id → { seq, list, loading }
let promptTip = null;

function promptLabel(p) {
  let t = p.text || '';
  if (p.cowork) t = t.replace(/^\[polycli [^\]]*\][^\n]*?Please handle it:\s*/, '');
  return t.replace(/<\/?pasted_content[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function promptTime(at) {
  const d = new Date(at), today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return today ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}

function renderPrompts(pane, s) {
  const box = pane.querySelector('.prompts');
  if (!box) return;
  const seq = s.historySeq || 0;
  let c = promptCache.get(s.id);
  if (!c) { c = { seq: -1, list: [], loading: false }; promptCache.set(s.id, c); }
  if (c.seq !== seq && !c.loading) {
    c.loading = true;
    const want = seq;
    call('prompts', { id: s.id }).then(list => { c.list = list; c.seq = want; }).catch(() => { c.seq = want; })
      .finally(() => {
        c.loading = false;
        const cur = S.sessions.find(x => x.id === s.id);
        if (cur && document.body.contains(pane)) renderPrompts(pane, cur);
      });
  }
  const hidden = !!S.ui.promptsHidden;
  const key = `${hidden}:${c.seq}`;
  if (box.dataset.drawn === key) return;
  box.dataset.drawn = key;
  box.classList.toggle('hidden', hidden);
  if (hidden) {
    box.innerHTML = `<button class="icon-btn" data-act="prompts-toggle" title="Show the prompts sent to this session">‹</button>`;
    return;
  }
  const lastClear = c.list.map(p => !!p.mark).lastIndexOf(true);
  const items = [];
  c.list.forEach((p, i) => {
    if (p.mark === 'clear') { items.push(`<div class="prompt-sep">/clear</div>`); return; }
    if (!p.text) return;
    const gone = i < lastClear;
    items.push(`<button class="prompt-item${p.cowork ? ' cowork' : ''}${gone ? ' gone' : ''}" data-prompt="${i}"><span class="pt">${esc(promptLabel(p).slice(0, 160))}</span><span class="pm">${esc(promptTime(p.at))}</span></button>`);
  });
  box.innerHTML = `<div class="prompts-head"><span>Prompts</span><button class="icon-btn" data-act="prompts-toggle" title="Hide the prompt list">›</button></div>
    <div class="prompts-list">${items.length ? items.reverse().join('') : '<div class="prompts-empty">The prompts you send to this session are listed here, newest first. Hover one to read it, click it to scroll to it.</div>'}</div>`;
}

function promptOf(el) {
  const pane = el.closest('.pane');
  const sid = pane?.dataset.tab?.slice(2);
  const c = sid && promptCache.get(sid);
  const i = Number(el.dataset.prompt);
  return c && c.list[i] ? { pane, sid, list: c.list, i, p: c.list[i] } : null;
}

document.addEventListener('mouseover', e => {
  const el = e.target.closest?.('.prompt-item');
  if (!el) return;
  const x = promptOf(el);
  if (!x) return;
  if (!promptTip) { promptTip = document.createElement('div'); promptTip.className = 'prompt-tip'; document.body.appendChild(promptTip); }
  const text = (x.p.text || '').replace(/<\/?pasted_content[^>]*>/g, '').trim();
  const lastClear = x.list.map(p => !!p.mark).lastIndexOf(true);
  promptTip.innerHTML = `<div class="tip-body">${esc(text.length > 3000 ? text.slice(0, 3000) + '…' : text)}</div><small>${esc(promptTime(x.p.at))} · ${x.i < lastClear ? 'Before /clear: no longer in the transcript' : 'Click to scroll to it'}</small>`;
  promptTip.hidden = false;
  const body = promptTip.firstElementChild;
  body.classList.toggle('clipped', body.scrollHeight > body.clientHeight);
  const r = el.getBoundingClientRect();
  promptTip.style.top = '0px';
  const { width: w, height: h } = promptTip.getBoundingClientRect();
  promptTip.style.left = `${Math.max(8, r.left - w - 8)}px`;
  promptTip.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - h - 8))}px`;
});
document.addEventListener('mouseout', e => {
  if (promptTip && e.target.closest?.('.prompt-item') && !e.relatedTarget?.closest?.('.prompt-item')) promptTip.hidden = true;
});

async function promptClick(el) {
  const x = promptOf(el);
  if (!x) return;
  if (promptTip) promptTip.hidden = true;
  const lastClear = x.list.map(p => !!p.mark).lastIndexOf(true);
  if (x.i < lastClear) return toast('This prompt was sent before /clear; it is no longer in the transcript.');
  const t = terms.get(`s:${x.sid}`);
  if (!t || !t.ready) return toast('The session is not attached.');
  // Paging keys would move the selection of a permission prompt or menu instead.
  if (S.sessions.find(q => q.id === x.sid)?.state === 'needs-you') return toast('Answer Claude first; the transcript scrolls once the prompt is gone.');
  el.classList.add('seeking');
  try {
    const found = await seekPrompt(t, x.list, x.i);
    if (!found) toast("Couldn't find this prompt in Claude's transcript. It may be from before a compaction.");
  } finally {
    el.classList.remove('seeking');
    t.term.focus();
  }
}

// How a prompt shows in Claude's transcript: a row starting with ❯, then the prompt
// (wrapped over the next rows). Compared without whitespace, since wrapping and
// indentation change it.
const squash = s => s.replace(/[\s\u00a0]+/g, '');
// Pasted text comes wrapped in <pasted_content> tags, which the transcript doesn't show.
function promptMatcher(text) {
  const t = String(text || '').replace(/<\/?pasted_content[^>]*>/g, '').replace(/^\s+/, '');
  const first = t.split('\n')[0];
  const whole = squash(first);
  // A short first line must match the whole row: "yes" must not find "yes, and also…".
  return whole.length <= 40 && first.length < 60 ? { exact: whole } : { prefix: whole.slice(0, 40) };
}
const sameMatcher = (a, b) => a.exact === b.exact && a.prefix === b.prefix;

function screenRows(term) {
  const b = term.buffer.active, rows = [];
  for (let i = 0; i < term.rows; i++) rows.push((b.getLine(b.viewportY + i)?.translateToString(true) || '').replace(/\u00a0/g, ' ').trimEnd());
  return rows;
}
// The transcript ends above Claude's input box, which sits between two ── rules (the
// upper one can carry the session's name).
function transcriptEnd(rows) {
  const rules = rows.map((r, i) => (/^─{10,}/.test(r.trim()) ? i : -1)).filter(i => i >= rows.length - 20 && i >= 0);
  return rules.length >= 2 ? rules[rules.length - 2] : rules.length ? rules[0] : rows.length;
}
// The top row is skipped on Claude's screen: while a prompt's answer is in view, Claude
// pins a copy of the prompt there.
function matchRows(rows, m, end = transcriptEnd(rows), from = 1) {
  const out = [];
  for (let i = from; i < end; i++) {
    if (!rows[i].startsWith('❯')) continue;
    const head = squash(rows[i].slice(1));
    if (m.exact !== undefined ? head === m.exact : squash([rows[i].slice(1), ...rows.slice(i + 1, Math.min(end, i + 5))].join(' ')).startsWith(m.prefix)) out.push(i);
  }
  return out;
}

// Resolves when Claude has redrawn after input: shortly after the last write, or at a cap.
// With no redraw at all (already at the end), it waits `idle`.
function settle(t, idle = 700, cap = 1500) {
  return new Promise(res => {
    let quiet;
    const done = () => { sub.dispose(); clearTimeout(quiet); clearTimeout(limit); res(); };
    const sub = t.term.onWriteParsed(() => { clearTimeout(quiet); quiet = setTimeout(done, 80); });
    quiet = setTimeout(done, idle);
    const limit = setTimeout(done, cap);
  });
}
const seekLog = [];   // the last search's steps, for the smoke test
// Keys Claude Code's fullscreen view scrolls its transcript with: Page Up moves it by
// half a screen, Ctrl+End goes to the newest message.
const KEY = { pageUp: '\x1b[5~', end: '\x1b[1;5F' };
async function sendKey(t, seq, idle) {
  if (seq) t.term.input(seq, false);
  await settle(t, idle, (idle || 700) + 800);
}
// Claude shows "Jump to bottom (ctrl+End)" while its transcript is scrolled up.
async function toNewest(t) {
  let rows = screenRows(t.term);
  for (let k = 0; k < 4; k++) {
    await sendKey(t, KEY.end, 500 + k * 300);
    const n = screenRows(t.term);
    const settled = sameRows(n, rows);
    rows = n;
    if (settled && !rows.some(r => /Jump to bottom/.test(r))) break;
  }
  return rows;
}
const sameRows = (a, b) => a.length === b.length && a.every((r, i) => r === b[i]);
// How far the transcript moved down between two screens: b[i + d] === a[i].
function shiftOf(a, b, end) {
  let best = null, score = 2;
  for (let d = 1; d < end; d++) {
    let n = 0;
    for (let i = 0; i + d < end; i++) if (a[i] && a[i] === b[i + d]) n++;
    if (n > score) { score = n; best = d; }
  }
  return best;
}

// Claude Code draws its own scrollable transcript in the alternate screen, so xterm
// has no scrollback to search: polycli pages Claude's transcript up from the newest
// message, as the keyboard does, until the prompt's row shows. Later prompts with the
// same text are counted on the way, so "yes" finds the right "yes".
async function seekPrompt(t, list, idx) {
  if (t.seeking) return true;
  t.seeking = true;
  try {
    const term = t.term;
    const m = promptMatcher(list[idx].text);
    let later = 0;
    for (const p of list.slice(idx + 1)) { if (p.mark === 'clear') later = 0; else if (p.text && sameMatcher(promptMatcher(p.text), m)) later++; }
    seekLog.length = 0;
    seekLog.push({ m, later, type: term.buffer.active.type });
    const mark = row => {
      const r = screenRows(term)[row] || '';
      term.select(0, term.buffer.active.viewportY + row, Math.max(1, r.length));
      const sel = term.getSelection();
      setTimeout(() => { if (term.getSelection() === sel) term.clearSelection(); }, 4000);
    };
    if (term.buffer.active.type === 'normal') {
      // Claude without its fullscreen view: the transcript is in xterm's scrollback.
      const b = term.buffer.active, hits = [];
      const line = i => (b.getLine(i)?.translateToString(true) || '').replace(/\u00a0/g, ' ').trimEnd();
      // Stop above Claude's input box on the last screen, so a matching draft isn't a hit.
      const last = b.baseY + transcriptEnd(Array.from({ length: term.rows }, (_, k) => line(b.baseY + k)));
      for (let i = 0; i < last; i++) {
        if (!line(i).startsWith('❯')) continue;
        const near = Array.from({ length: Math.min(5, last - i) }, (_, k) => line(i + k));
        if (matchRows(near, m, near.length, 0)[0] === 0) hits.push(i);
      }
      const at = hits[hits.length - 1 - later];
      if (at === undefined) return false;
      term.scrollToLine(Math.max(0, at - 2));
      term.select(0, at, line(at).length);
      return true;
    }
    let rows = await toNewest(t);
    const seen = new Set();
    let offset = 0;   // how far the transcript has moved down since the newest message
    const found = (from = 1) => {
      for (const row of matchRows(rows, m, transcriptEnd(rows), from).reverse()) {   // bottom to top
        if (seen.has(row - offset)) continue;
        seen.add(row - offset);
        if (seen.size > later) return row;
      }
      return null;
    };
    seekLog.push({ bottom: rows.map((r, j) => (r.startsWith('❯') ? `${j}:${r.slice(0, 20)}` : null)).filter(Boolean), last: rows.slice(-8, -5) });
    let row = found(), step = null;
    for (let i = 0; row === null && i < 3000; i++) {
      const end = transcriptEnd(rows);
      // Claude can take a moment to answer a key (after a turn, while its hooks run):
      // no change means the top only once the key was tried a few times.
      let n = rows;
      for (let k = 0; k < 4 && sameRows(n, rows); k++) {
        await sendKey(t, k % 2 ? '' : KEY.pageUp, 700 + k * 300);
        n = screenRows(term);
      }
      // At the top of the transcript nothing is pinned: the first row counts too.
      if (sameRows(n, rows)) { row = found(0); break; }
      const sd = shiftOf(rows, n, end);
      const d = sd ?? step ?? Math.floor(end / 2);
      seekLog.push({ end, d, sd, marks: n.map((r, j) => (r.startsWith('❯') ? `${j}:${r.slice(0, 20)}` : null)).filter(Boolean) });
      step ??= d;
      offset += d;
      rows = n;
      row = found();
    }
    if (row === null) {
      await toNewest(t);
      return false;
    }
    mark(row);
    return true;
  } finally {
    t.seeking = false;
  }
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
// One text answer in a dialog; resolves to the text, or null when cancelled.
function ask(title, label, value = '') {
  return new Promise(resolve => {
    let answer = null;
    const form = modal(`<h3>${esc(title)}</h3>
      <label class="field"><span>${esc(label)}</span><input name="v" value="${esc(value)}" maxlength="80" required></label>
      <div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">OK</button></div>`,
    async fd => { answer = String(fd.get('v')).trim(); });
    form.querySelector('input').focus();
    const back = $('#modalBack');
    new MutationObserver((_m, ob) => { if (back.hidden) { ob.disconnect(); resolve(answer); } }).observe(back, { attributes: true, attributeFilter: ['hidden'] });
  });
}
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
    <label class="check-row"><input type="checkbox" name="remote" ${S.ui.remoteDefault !== false ? 'checked' : ''}><span>Remote Control: continue this session from claude.ai/code or the Claude mobile app (needs a claude.ai login, not an API key). Your choice is remembered for the next session.</span></label>
    <div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Start session</button></div>`,
  async fd => {
    const remote = fd.get('remote') === 'on';
    await api.call('newSession', { workstreamId: ws.id, role: fd.get('role'), cwd: fd.get('cwd').trim(), model: fd.get('model'), effort: fd.get('effort'), remote });
    if (remote !== (S.ui.remoteDefault !== false)) api.call('setUi', { remoteDefault: remote });
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
    <div class="row">
      <label class="field"><span>Prompts from linked Cowork tasks</span><select name="coworkSend"><option value="ask" ${(ws.coworkSend || 'ask') === 'ask' ? 'selected' : ''}>Ask me each time</option><option value="allow" ${ws.coworkSend === 'allow' ? 'selected' : ''}>Send without asking</option></select></label>
    </div>
    <label class="field"><span>Deploy command (runs in a new shell tab from the Deploy button; leave empty to use a package.json "deploy" script if there is one)</span><input name="deploy" value="${esc(ws.deploy || '')}" placeholder="npm run deploy" spellcheck="false" style="font-family:var(--mono)"></label>
    <label class="check-row"><input type="checkbox" name="billable" ${ws.billable ? 'checked' : ''}><span>Billable workstream: count my time while it is selected and polycli is focused, minus Claude's generation time. Monthly totals are in the top-right pill.</span></label>
    <div class="field"><span>Global keys this workstream uses (for your own tracking; every session already has them)</span>
      <div class="key-checks">${globals.length ? globals.map(g => `<label class="key-check"><input type="checkbox" name="uses" value="${esc(g.name)}" ${uses.has(g.name) ? 'checked' : ''}><code>${esc(g.name)}</code>${g.scope === 'machine' ? '<small>machine</small>' : ''}</label>`).join('') : '<span class="hint">No key-like Windows variables found.</span>'}</div>
    </div>
    <div class="modal-actions"><button type="button" class="btn danger" id="wsArchive" style="margin-right:auto" title="Close its sessions and shells and hide it from the rail">Archive workstream…</button><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div>`,
  async (fd, f) => {
    const env = [...f.querySelectorAll('.env-row')].map(r => {
      const name = r.querySelector('.env-name').value.trim();
      const value = r.querySelector('.env-value').value;
      return r.dataset.existing && !value ? { name } : { name, value };
    }).filter(e => e.name || e.value);
    await api.call('updateWorkstream', { id: ws.id, name: fd.get('name'), color, env, uses: fd.getAll('uses'), deploy: fd.get('deploy'), coworkSend: fd.get('coworkSend') });
    if ((fd.get('billable') === 'on') !== !!ws.billable) await api.call('setBillable', { workstreamId: ws.id, on: fd.get('billable') === 'on' });
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
  form.querySelector('#wsArchive').onclick = () => archiveDialog(ws);
  form.querySelectorAll('[data-color]').forEach(b => b.onclick = () => {
    color = b.dataset.color;
    form.querySelectorAll('.swatch').forEach(x => x.classList.toggle('sel', x === b));
  });
}

function archiveDialog(ws) {
  const open = sessionsOf(ws.id).filter(isOpenSession), shells = shellsOf(ws.id);
  const working = open.filter(s => ['busy', 'needs-you'].includes(s.state));
  const what = [open.length && `${open.length} Claude session${open.length === 1 ? '' : 's'}`, shells.length && `${shells.length} shell${shells.length === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
  modal(`<h3>Archive ${esc(ws.name)}?</h3>
    <p>${what ? `This closes its ${what}.${open.length ? ' Claude conversations are kept and can be reopened after you restore the workstream.' : ''}${shells.length ? ' Shells are closed for good.' : ''}` : 'Nothing is open in it.'}</p>
    <p class="hint">The workstream moves to the Archived list at the bottom of the left rail, with its settings, variables and Cowork history. Linked Cowork tasks can't use it until you restore it.</p>
    ${working.length ? `<p class="warn-text">Claude is working in ${working.map(s => esc(s.name)).join(', ')}. Wait until it is idle.</p>` : ''}
    <div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Archive</button></div>`,
  async () => { await call('archiveWorkstream', { id: ws.id }); toast(`${ws.name} archived`); });
}

// Global keys: the key-like variables saved in Windows (names only), which workstreams
// say they use, and which workstreams set their own value.
async function keysDialog() {
  const globals = await call('globalKeys');
  const usedBy = n => S.workstreams.filter(w => (w.uses || []).includes(n));
  const setIn = n => S.workstreams.filter(w => (w.env || []).some(e => e.name.toUpperCase() === n.toUpperCase()));
  const chips = ws => ws.map(w => `<span class="ws-chip ${w.archived ? 'archived' : ''}" ${w.archived ? 'title="Archived"' : ''}><span class="ws-color" style="background:${esc(w.color)}"></span>${esc(w.name)}${w.archived ? ' <small>archived</small>' : ''}</span>`).join('');
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
      const start = tag === 'ol' && parseInt(m[1], 10) > 1 ? ` start="${parseInt(m[1], 10)}"` : '';
      if (list !== tag) { if (list) out.push(`</${list}>`); out.push(`<${tag}${start}>`); list = tag; }
      out.push(`<li>${mdInline(m[2])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list}>`); list = null; }
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}
async function appSettingsDialog() {
  const li = await call('loginItem');
  const form = modal(`<h3>polycli settings</h3>
    <label class="check-row"><input type="checkbox" name="login" ${li.on ? 'checked' : ''}><span>Start polycli when I sign in to Windows</span></label>
    <p class="hint">${li.packaged ? '' : 'polycli runs from source here, so Windows starts Electron with this app folder; Startup apps in Windows Settings lists it as Electron. '}Claude sessions that were open are reattached when it starts; after a restart of Windows they start again with their conversation.</p>
    <div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div>`,
  async fd => {
    const on = fd.get('login') === 'on';
    if (on !== li.on) { const r = await call('setLoginItem', { on }); toast(r.on ? 'polycli will start when you sign in' : 'polycli will no longer start when you sign in'); }
  });
  return form;
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
  const cwEl = e.target.closest('[data-cw]');
  if (cwEl) return coworkClick(cwEl);
  const promptEl = e.target.closest('[data-prompt]');
  if (promptEl) return promptClick(promptEl);
  const el = e.target.closest('[data-close],[data-tab],[data-select-ws],[data-act],[data-reopen],[data-closed],[data-archived-toggle],[data-restore-ws]');
  if (!el) {
    if (!e.target.closest('.inbox-menu')) $('#inboxMenu').hidden = true;
    return;
  }
  if ((el.dataset.tab || el.dataset.selectWs) && !leaveOk()) return;
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
    S.ui.view = 'main';
    await call('setUi', { activeTab: el.dataset.tab, view: 'main' });
    return;
  }
  if (el.dataset.selectWs) { await call('setActive', { id: el.dataset.selectWs }); return; }
  if (el.dataset.archivedToggle) { showArchived = !showArchived; render(); return; }
  if (el.dataset.restoreWs) { await call('restoreWorkstream', { id: el.dataset.restoreWs }); return; }
  if (el.dataset.reopen) { await call('reopenSession', { id: el.dataset.reopen }); return; }
  if (el.dataset.closed) {
    showClosed.has(el.dataset.closed) ? showClosed.delete(el.dataset.closed) : showClosed.add(el.dataset.closed);
    render();
    return;
  }
  const act = el.dataset.act;
  if (act === 'prompts-toggle') { S.ui.promptsHidden = !S.ui.promptsHidden; render(); return call('setUi', { promptsHidden: S.ui.promptsHidden }); }
  const ws = activeWs();
  const sid = el.closest('[data-session]')?.dataset.session;
  const hid = el.closest('[data-shell]')?.dataset.shell;
  if (act === 'newClaude' && ws) return newSessionDialog(ws);
  if (act === 'newShell' && ws) return call('newShell', { workstreamId: ws.id }).then(() => setView('main'));
  if (act === 'newMistral' && ws) return call('newShell', { workstreamId: ws.id, agent: 'mistral' }).then(() => setView('main'));
  if (act === 'wsCode' && ws) return openVSCode({ workstreamId: ws.id }, e);
  if (act === 'wsSettings' && ws) return wsSettingsDialog(ws);
  if (act === 'wsCowork' && ws) return coworkDialog(ws);
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

// Main (terminals), Architecture and Docs: the view of the active workstream.
const leaveOk = () => !isDirty() || confirm('This document has unsaved changes. Discard them?');
function setView(view) {
  if ((S.ui.view || 'main') === view || !leaveOk()) return;
  S.ui.view = view;
  render();
  return call('setUi', { view });
}
$('#viewbar').onclick = e => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); };
$('#addWs').onclick = newWorkstreamDialog;
$('#themeBtn').onclick = () => {
  const order = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(S.ui.theme || 'system') + 1) % order.length];
  S.ui.theme = next;
  applyTheme();
  call('setUi', { theme: next });
};
$('#keysBtn').onclick = () => keysDialog();
$('#billBtn').onclick = () => billingDialog();
$('#helpBtn').onclick = () => helpDialog();
$('#appSettingsBtn').onclick = () => appSettingsDialog();
$('#inboxBtn').onclick = e => { e.stopPropagation(); $('#inboxMenu').hidden = !$('#inboxMenu').hidden; };

api.onState(s => { S = s; render(); });
api.onFocusTab(async tab => {
  const s = S.sessions.find(x => x.id === tab.slice(2));
  if (s) await call('setActive', { id: s.workstreamId });
  await call('setUi', { activeTab: tab, view: 'main' });
});
api.onData((termId, data) => {
  const t = terms.get(termId);
  if (!t) return;
  if (t.ready) t.term.write(data); else t.queue.push(data);
});

call('state').then(s => { S = s; render(); });
window.__polycli = { get state() { return S; }, terms, seekLog };
