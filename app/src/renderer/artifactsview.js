// The Artifacts view of a workstream: a list of what its Cowork tasks reported and its
// Claude sessions made (claude.ai artifacts, documents), and a viewer beside it.
// claude.ai and other https pages open in a <webview> (its own login, kept between
// runs); local HTML, images and PDFs through polycli-art://; Markdown as a preview.
// Everything is named by the ids the main process lists (artifacts.js).

import { renderMarkdown } from './views.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = ms => {
  if (!ms) return '';
  const d = Math.max(0, Date.now() - ms), m = Math.round(d / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const PARTITION = 'persist:polycli-web';

const mem = new Map();   // workstream id → { selected, filter, query, local }
const memOf = id => { if (!mem.has(id)) mem.set(id, { selected: null, filter: 'all', query: '', local: false }); return mem.get(id); };

let ctx = null;          // { el, ws, call, toast, items, rev, shown }

export function artifactsView(c) {
  ctx = { el: c.el, ws: c.ws, call: c.call, toast: c.toast, items: [], rev: c.ws.artifactsRev, shown: null };
  const m = memOf(c.ws.id);
  c.el.innerHTML = `<div class="av">
    <div class="av-list">
      <div class="av-head"><h2>Artifacts</h2><span class="grow"></span><button class="btn" data-a="refresh" title="Look again in the sessions' transcripts">↻</button></div>
      <div class="av-filters">
        <span class="seg">${['all', 'session', 'cowork'].map(f => `<button class="btn${m.filter === f ? ' seg-on' : ''}" data-a="filter" data-f="${f}">${{ all: 'All', session: 'Sessions', cowork: 'Cowork' }[f]}</button>`).join('')}</span>
        <input class="av-search" type="search" placeholder="Filter" value="${esc(m.query)}">
      </div>
      <div class="av-items"><div class="av-empty">Looking in the sessions and Cowork…</div></div>
    </div>
    <div class="av-view"><div class="av-placeholder"><p>Pick an artifact to open it here.</p></div></div>
  </div>`;
  const me = ctx;
  c.el.onclick = e => {
    const b = e.target.closest('[data-a]');
    if (!b || !c.el.contains(b)) return;
    const a = b.dataset.a;
    if (a === 'refresh') return load(me, true);
    if (a === 'filter') { m.filter = b.dataset.f; c.el.querySelectorAll('[data-a=filter]').forEach(x => x.classList.toggle('seg-on', x === b)); return drawList(me); }
    if (a === 'item') { m.selected = b.dataset.id; m.local = false; drawList(me); return show(me); }
    const it = me.items.find(x => x.id === m.selected);
    if (!it) return;
    // In the browser: the page the viewer is on now (a link may have been followed).
    const web = c.el.querySelector('webview.av-frame');
    if (a === 'browser' && web && /^https:\/\//i.test(web.getURL?.() || '')) return c.call('openLink', { url: web.getURL() }).catch(() => {});
    if (a === 'browser' || a === 'folder') return c.call('artifactOpen', { workstreamId: me.ws.id, id: it.id, how: a }).catch(() => {});
    if (a === 'back') return web?.canGoBack() && web.goBack();
    if (a === 'local') { m.local = !m.local; return show(me); }
    if (a === 'reload') { const w = c.el.querySelector('.av-frame'); if (w?.reload) w.reload(); else if (w) w.src = w.src; }
  };
  c.el.querySelector('.av-search').oninput = e => { m.query = e.target.value; drawList(me); };
  load(me, true);
}

export function leaveArtifacts() { ctx = null; }

// Called on every state push while the view is on screen: reload the list when a
// session or a Cowork task reported something new.
export function artifactsTick(ws) {
  if (!ctx || ctx.ws.id !== ws.id) return;
  ctx.ws = ws;
  if (ws.artifactsRev !== ctx.rev) { ctx.rev = ws.artifactsRev; load(ctx, false); }
}

async function load(me, rescan) {
  let r;
  try { r = await me.call('artifactList', { workstreamId: me.ws.id, rescan }); } catch { return; }
  if (ctx !== me) return;
  me.items = r.items;
  drawList(me);
  const m = memOf(me.ws.id);
  // The selected item may have changed (its local copy appeared, it was published).
  const it = me.items.find(x => x.id === m.selected);
  if (it && JSON.stringify(viewOf(it, m)) !== JSON.stringify(me.shown)) show(me);
}

function drawList(me) {
  const m = memOf(me.ws.id);
  const q = m.query.trim().toLowerCase();
  const list = me.items.filter(it => (m.filter === 'all' || it.source === m.filter)
    && (!q || `${it.title} ${it.description || ''} ${it.from} ${it.url || ''} ${it.path || ''}`.toLowerCase().includes(q)));
  const box = me.el.querySelector('.av-items');
  if (!box) return;
  box.innerHTML = list.length ? list.map(it => `<button class="av-item${it.id === m.selected ? ' on' : ''}${it.path && !it.url && !it.exists ? ' gone' : ''}" data-a="item" data-id="${esc(it.id)}" title="${esc(it.url || it.path)}">
      <span class="av-top"><span class="tile-badge${it.source === 'cowork' ? ' cw' : ''}">${it.url ? (/claude\.ai\//.test(it.url) ? 'claude.ai' : 'link') : esc(it.kind)}</span><span class="av-ago">${esc(ago(it.at))}</span></span>
      <span class="av-title">${esc(it.title)}</span>
      ${it.description ? `<span class="av-desc">${esc(it.description)}</span>` : ''}
      <span class="av-from">${it.source === 'cowork' ? '◇ ' : ''}${esc(it.from)}${it.path && !it.url && !it.exists ? ' · file removed' : ''}</span></button>`).join('')
    : `<div class="av-empty">${me.items.length ? 'Nothing matches.' : `<h3>No artifacts yet</h3><p>Pages a Claude session publishes (claude.ai artifacts), documents it writes (Markdown, HTML, PDF…), and what a linked Cowork task reports with <code>polycli_add_artifact</code> show up here.</p>`}</div>`;
}

// What the viewer shows for an item: a page, a local file, Markdown, or nothing.
function viewOf(it, m) {
  const local = it.viewable && (m.local || !it.url);
  if (it.url && !local) return { kind: 'web', src: it.url };
  if (local && it.markdown) return { kind: 'md', id: it.id };
  if (local) return { kind: /\.(png|jpe?g|gif|webp|svg)$/i.test(it.path) ? 'img' : 'file', src: `polycli-art://${it.wsId}/${encodeURIComponent(it.id)}/${encodeURIComponent(it.path.split(/[\\/]/).pop())}` };
  return { kind: 'none' };
}

async function show(me) {
  const m = memOf(me.ws.id);
  const it = me.items.find(x => x.id === m.selected);
  const pane = me.el.querySelector('.av-view');
  if (!it || !pane) return;
  const v = viewOf({ ...it, wsId: me.ws.id }, m);
  me.shown = viewOf(it, m);
  const bar = `<div class="pv-bar">${v.kind === 'web' ? '<button class="btn" data-a="back" title="Back">‹</button>' : ''}<span class="pv-path" title="${esc(it.url || it.path)}">${esc(it.title)}</span><span class="grow"></span>
    ${it.url && it.viewable ? `<button class="btn" data-a="local" title="${m.local ? 'Show the published page' : 'Show the copy on this PC'}">${m.local ? 'Online' : 'Local copy'}</button>` : ''}
    ${v.kind === 'web' || v.kind === 'file' ? '<button class="btn" data-a="reload" title="Reload">↻</button>' : ''}
    ${it.url ? '<button class="btn" data-a="browser" title="Open in your browser">Open in browser</button>' : ''}
    ${it.path && it.exists ? '<button class="btn" data-a="folder" title="Show the file in Explorer">Show in folder</button>' : ''}</div>`;
  if (v.kind === 'web') {
    pane.innerHTML = `${bar}<webview class="av-frame" partition="${PARTITION}" allowpopups src="${esc(v.src)}"></webview>`;
    const w = pane.querySelector('webview');
    w.addEventListener('did-fail-load', e => {
      if (e.errorCode === -3 || !e.isMainFrame) return;   // -3: aborted by a redirect
      me.toast(`Could not load the page: ${e.errorDescription || e.errorCode}`);
    });
  } else if (v.kind === 'file') {
    pane.innerHTML = `${bar}<iframe class="av-frame" sandbox="allow-scripts allow-same-origin" src="${esc(v.src)}" title="${esc(it.title)}"></iframe>`;
  } else if (v.kind === 'img') {
    pane.innerHTML = `${bar}<div class="pv-scroll center"><img class="pv-img" src="${esc(v.src)}" alt="${esc(it.title)}"></div>`;
  } else if (v.kind === 'md') {
    pane.innerHTML = `${bar}<div class="pv-scroll"><article class="pv-md">Loading…</article></div>`;
    const art = pane.querySelector('.pv-md');
    try {
      const { text } = await me.call('artifactRead', { workstreamId: me.ws.id, id: it.id });
      if (ctx !== me || memOf(me.ws.id).selected !== it.id) return;
      art.innerHTML = renderMarkdown(text, { wsId: me.ws.id, dir: '' });
    } catch { art.textContent = 'This file could not be read.'; }
    art.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      if (a.dataset.mdExt) return me.call('openLink', { url: a.dataset.mdExt });
      if (a.dataset.mdAnchor) art.querySelector(`[id="${CSS.escape(a.dataset.mdAnchor)}"]`)?.scrollIntoView();
    });
  } else {
    pane.innerHTML = `${bar}<div class="pv-empty"><h3>${esc(it.title)}</h3><p>${it.path && !it.exists ? 'This file is no longer there.' : `A ${esc(it.kind)} file can't be shown here.`}</p>${it.path ? `<p><code>${esc(it.path)}</code></p>` : ''}</div>`;
  }
}
