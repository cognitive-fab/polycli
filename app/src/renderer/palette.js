// The command palette (docs/design/v0.4.md §9): Ctrl+K (outside a terminal) or
// Ctrl+Shift+P anywhere, or the global hotkey. Type to jump to a workstream, session,
// shell or view, or to run a command; start with ? to search prompts, artifacts and
// board cards in every workstream.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const VIEWS = [['main', 'Main'], ['board', 'Board'], ['architecture', 'Architecture'], ['docs', 'Docs'], ['tests', 'Tests'], ['artifacts', 'Artifacts'], ['worktrees', 'Worktrees']];
const RECENT_KEY = 'polycli.palette.recent';

// Subsequence match, boosted for word starts and consecutive letters. → score or -1.
export function fuzzy(query, text) {
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (!q) return 0;
  let score = 0, ti = 0, run = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return -1;
    const start = i === 0 || /[\s·/\\._-]/.test(t[i - 1]);
    run = i === ti ? run + 1 : 0;
    score += 1 + (start ? 3 : 0) + run * 2 - Math.min(3, (i - ti) * 0.1);
    ti = i + 1;
  }
  return score - t.length * 0.01;
}

let el = null;

export function openPalette(h) {
  const { S, call, toast, actions } = h;
  if (el) { el.querySelector('input').focus(); return; }
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch {}
  const ws = S.workstreams.find(w => w.id === S.ui.activeWorkstream);
  const activeTab = S.ui.activeTab || '';
  const curSession = activeTab.startsWith('s:') ? S.sessions.find(s => s.id === activeTab.slice(2)) : null;

  // Everything to jump to or run, built from the state the window already has.
  const items = [];
  for (const w of S.workstreams.filter(x => !x.archived)) items.push({ id: `w:${w.id}`, kind: 'workstream', label: w.name, sub: w.folderShort || w.folder, run: () => call('setActive', { id: w.id }) });
  for (const s of S.sessions) {
    const w = S.workstreams.find(x => x.id === s.workstreamId);
    if (!w || w.archived) continue;
    const closed = !s.open || s.state === 'closed';
    items.push({ id: `s:${s.id}`, kind: closed ? 'closed session' : 'session', label: s.name, sub: closed ? 'reopen' : s.state, run: () => (closed ? call('reopenSession', { id: s.id }) : actions.focusTab(w.id, `s:${s.id}`)) });
  }
  for (const sh of S.shells) {
    const w = S.workstreams.find(x => x.id === sh.workstreamId);
    if (w && !w.archived) items.push({ id: `h:${sh.id}`, kind: 'shell', label: `${w.name} · ${sh.name}`, sub: sh.cwdShort || '', run: () => actions.focusTab(w.id, `h:${sh.id}`) });
  }
  if (ws) for (const [v, name] of VIEWS) items.push({ id: `v:${v}`, kind: 'view', label: `${ws.name} · ${name}`, sub: 'view', run: () => actions.setView(v) });
  const cmd = (id, label, sub, run, when = true) => when && items.push({ id: `c:${id}`, kind: 'command', label, sub, run });
  if (ws) {
    cmd('new-session', `New Claude session in ${ws.name}`, 'command', () => actions.newSession(ws));
    cmd('new-shell', `New shell in ${ws.name}`, 'command', () => actions.newShell(ws));
    cmd('ws-settings', `${ws.name} settings`, 'plugins, skills, permissions…', () => actions.wsSettings(ws));
    cmd('vscode', `Open ${ws.name} in VS Code`, 'command', () => call('openVSCode', { workstreamId: ws.id }));
    cmd('cleanup', `Clean up merged worktrees of ${ws.name}`, 'Worktrees view', () => actions.setView('worktrees'));
  }
  if (curSession) {
    const n = curSession.name;
    cmd('restart', `Restart ${n}`, 'session', () => call('restartSession', { id: curSession.id }));
    cmd('review', `Run /code-review in ${n}`, 'session', () => actions.reviewLight(curSession.id));
    cmd('compact', `Compact ${n}`, 'session: /compact', () => call('compactSession', { id: curSession.id }).then(() => toast('Compacting the conversation')), curSession.state === 'idle');
    cmd('handoff', `Hand off ${n} to a new session…`, 'session', () => actions.handOff(curSession.id), curSession.state === 'idle');
    cmd('commit', `Commit in ${n}`, 'git', () => actions.act('git-commit', curSession.id), !!curSession.git);
    cmd('push', `Push from ${n}`, 'git', () => actions.act('git-push', curSession.id), !!curSession.git?.branch);
    cmd('findings', `polywatch findings of ${n}`, 'session', () => actions.findings(`s:${curSession.id}`));
  }
  cmd('settings', 'polycli settings', 'profiles, start at sign-in, code review…', () => actions.appSettings());
  cmd('help', 'Help', 'polycli', () => actions.help());

  el = document.createElement('div');
  el.className = 'palette-back';
  el.innerHTML = `<div class="palette" role="dialog" aria-label="Command palette">
      <input type="text" placeholder="Jump to a workstream, session or view, or run a command · ? to search everything" spellcheck="false" aria-label="Search">
      <div class="palette-list" role="listbox"></div>
      <div class="palette-foot">↑↓ choose · Enter open · Esc close · <b>?</b> search prompts, artifacts and cards</div>
    </div>`;
  document.body.appendChild(el);
  const input = el.querySelector('input'), list = el.querySelector('.palette-list');
  let shown = [], sel = 0, searchSeq = 0;
  const close = () => { el?.remove(); el = null; };
  const draw = () => {
    list.innerHTML = shown.length ? shown.map((it, i) => `<div class="palette-item ${i === sel ? 'on' : ''}" data-i="${i}" role="option"><span class="pk">${esc(it.kind)}</span><span class="pl">${esc(it.label)}</span><span class="ps">${esc(it.sub || '')}</span></div>`).join('')
      : `<div class="palette-empty">${input.value.startsWith('?') ? (input.value.length > 2 ? 'Nothing found.' : 'Type at least two letters to search.') : 'Nothing matches.'}</div>`;
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const update = async () => {
    const q = input.value;
    sel = 0;
    if (q.startsWith('?')) {
      const text = q.slice(1).trim();
      const mine = ++searchSeq;
      if (text.length < 2) { shown = []; return draw(); }
      let r = [];
      try { r = await call('search', { q: text }); } catch {}
      if (mine !== searchSeq || !el) return;
      shown = r.map(x => ({ ...x, run: () => actions.openResult(x) }));
      return draw();
    }
    const rank = it => (recent.includes(it.id) ? 4 - recent.indexOf(it.id) / 3 : 0);
    shown = (q ? items.map(it => ({ it, s: fuzzy(q, `${it.label} ${it.kind}`) })).filter(x => x.s >= 0).sort((a, b) => b.s + rank(b.it) - (a.s + rank(a.it))).map(x => x.it)
      : [...items].sort((a, b) => rank(b) - rank(a))).slice(0, 50);
    draw();
  };
  const choose = it => {
    if (!it) return;
    close();
    if (it.id) {
      recent = [it.id, ...recent.filter(x => x !== it.id)].slice(0, 12);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch {}
    }
    Promise.resolve(it.run()).catch(() => {});
  };
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(update, input.value.startsWith('?') ? 180 : 0); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(shown[sel]); }
  });
  list.addEventListener('mousedown', e => { const i = e.target.closest('[data-i]'); if (i) { e.preventDefault(); choose(shown[+i.dataset.i]); } });
  el.addEventListener('mousedown', e => { if (e.target === el) close(); });
  update();
  input.focus();
}
