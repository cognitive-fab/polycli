// The Architecture and Docs views of a workstream: tiles for the archlens diagrams and
// for docs/ (folders drill down), an HTML viewer for a diagram or page, and a Markdown
// preview/editor. Files come from the workstream folder through the main process.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IMG = /\.(png|jpe?g|gif|webp|svg)$/i;
const HTML = /\.html?$/i;

// ---------------- Markdown ----------------
// Everything is escaped before any tag is added, so a document cannot inject markup.
const slug = t => t.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

// Relative reference → path from the workstream folder, kept inside architecture/ or docs/.
function resolveRel(baseDir, href) {
  const parts = href.startsWith('/') ? [] : baseDir.split('/');
  for (const p of href.split(/[?#]/)[0].split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') { parts.pop(); continue; }
    let seg = p;
    try { seg = decodeURIComponent(p); } catch {}   // a stray % in a name stays literal
    parts.push(seg);
  }
  const rel = parts.join('/');
  return /^(docs|architecture)(\/|$)/.test(rel) ? rel : null;
}

const viewUrl = (wsId, rel) => `polycli-view://${wsId}/${rel.split('/').map(encodeURIComponent).join('/')}`;

function inline(text, ctx) {
  const codes = [];
  let t = text.replace(/`([^`]+)`/g, (_m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = esc(t);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_m, alt, src) => {
    const url = src.replace(/&amp;/g, '&');
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(url)) return `<img alt="${alt}" src="${esc(url)}">`;
    const rel = /^[a-z]+:/i.test(url) ? null : resolveRel(ctx.dir, url);
    return rel && IMG.test(rel) ? `<img alt="${alt}" src="${esc(viewUrl(ctx.wsId, rel))}">` : `<span class="md-missing">[image: ${alt || esc(url)}]</span>`;
  });
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_m, label, href) => {
    const url = href.replace(/&amp;/g, '&');
    if (/^https:\/\//i.test(url)) return `<a href="#" data-md-ext="${esc(url)}">${label}</a>`;
    if (url.startsWith('#')) return `<a href="#" data-md-anchor="${esc(url.slice(1))}">${label}</a>`;
    if (/^[a-z]+:/i.test(url)) return label;
    const rel = resolveRel(ctx.dir, url);
    if (!rel) return label;
    return `<a href="#" data-md-open="${esc(rel)}">${label}</a>`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<i>$2</i>').replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<i>$2</i>').replace(/~~([^~]+)~~/g, '<s>$1</s>');
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${esc(codes[+i])}</code>`);
}

export function renderMarkdown(src, ctx) {
  const lines = src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').split(/\r?\n/);
  const out = [];
  let i = 0;
  const startsBlock = l => /^(#{1,6}\s|```|>|\s*([-*+]|\d+\.)\s|\s*(-{3,}|\*{3,})\s*$|\|)/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) { i++; continue; }
    if ((m = /^(`{3,}|~{3,})\s*([\w+-]*)/.exec(line))) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].startsWith(m[1])) buf.push(lines[i++]);
      i++;
      out.push(`<pre class="md-code"><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line))) {
      const html = inline(m[2], ctx);
      out.push(`<h${m[1].length} id="${esc(slug(m[2]))}">${html}</h${m[1].length}>`);
      i++; continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), ctx)}</blockquote>`);
      continue;
    }
    if (/^\|/.test(line) && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] || '')) {
      const cells = l => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
      const head = cells(line); i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="md-table"><table><thead><tr>${head.map(c => `<th>${inline(c, ctx)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${head.map((_h, k) => `<td>${inline(r[k] || '', ctx)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if ((m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line))) {
      // A list, with nested lists by indentation (two levels of nesting are plenty).
      const items = [];
      const ordered = /\d/.test(m[2]);
      const baseIndent = m[1].length;
      while (i < lines.length && (m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i])) && m[1].length >= baseIndent) {
        if (m[1].length > baseIndent && items.length) {
          const sub = [];
          while (i < lines.length && /^(\s*)([-*+]|\d+\.)\s+/.test(lines[i]) && lines[i].match(/^\s*/)[0].length > baseIndent) sub.push(lines[i++].slice(baseIndent + 1));
          items[items.length - 1].sub = renderMarkdown(sub.join('\n'), ctx);
          continue;
        }
        const task = /^\[( |x|X)\]\s+/.exec(m[3]);
        items.push({ text: task ? m[3].slice(task[0].length) : m[3], task: task ? task[1] !== ' ' : null });
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map(it => `<li>${it.task === null ? '' : `<input type="checkbox" disabled${it.task ? ' checked' : ''}> `}${inline(it.text, ctx)}${it.sub || ''}</li>`).join('')}</${tag}>`);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !(buf.length && startsBlock(lines[i]))) buf.push(lines[i++].trim());
    out.push(`<p>${inline(buf.join(' '), ctx)}</p>`);
  }
  return out.join('\n');
}

// ---------------- views ----------------
const mem = new Map();   // workstream id → { docDir, docFile, archFile, mode }
const memOf = id => { if (!mem.has(id)) mem.set(id, { docDir: 'docs', docFile: null, archFile: null }); return mem.get(id); };

const fileIcon = ext => ({ md: 'MD', markdown: 'MD', html: 'HTML', htm: 'HTML', pdf: 'PDF', png: 'IMG', jpg: 'IMG', jpeg: 'IMG', gif: 'IMG', webp: 'IMG', svg: 'IMG', json: 'JSON', yml: 'YML', yaml: 'YML', txt: 'TXT', csv: 'CSV' }[ext] || (ext ? ext.slice(0, 4).toUpperCase() : 'FILE'));
const ago = ms => {
  const d = Math.max(0, Date.now() - ms), m = Math.round(d / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

let current = null;   // { el, ws, view, dirty, ... } of the view on screen

// Called from render(): paints only when the workstream or the view changed, so the
// frequent state pushes never reload an iframe or throw away an edit in progress.
export function showProject(el, { ws, view, call, toast, ask }) {
  const key = `${ws.id}:${view}`;
  if (current && current.key === key && el.dataset.key === key) { current.ws = ws; return; }
  if (current?.dirty && current.ws.id !== ws.id && !confirm('This document has unsaved changes. Discard them?')) return;
  current = { key, el, ws, view, call, toast, ask, dirty: false };
  el.dataset.key = key;
  paint();
}
export function hideProject() { if (current) { current.el.dataset.key = ''; current = null; } }
export const isDirty = () => !!current?.dirty;

function paint() {
  const c = current;
  if (!c) return;
  c.dirty = false;
  const m = memOf(c.ws.id);
  if (c.view === 'docs') return m.docFile ? openFile(m.docFile, 'docs') : docsHome(m.docDir);
  return m.archFile ? (/\.(md|markdown)$/i.test(m.archFile) ? openFile(m.archFile, 'architecture') : archViewer(m.archFile)) : archHome();
}

const guard = () => !current?.dirty || confirm('This document has unsaved changes. Discard them?');
// One click listener per container; each paint just replaces the handler.
const bind = (root, fn) => {
  root._pv = fn;
  if (root._pvOn) return;
  root._pvOn = true;
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-v]');
    if (b && root.contains(b)) root._pv(b.dataset.v, b, e);
  });
};

async function archHome() {
  const c = current, ws = c.ws;
  c.el.innerHTML = `<div class="pv-scroll"><div class="pv-empty">Looking for diagrams…</div></div>`;
  let r;
  try { r = await c.call('archList', { workstreamId: ws.id }); } catch { return; }
  if (current !== c) return;
  const m = memOf(ws.id);
  const tiles = r.diagrams.map(d => `<button class="tile" data-v="arch" data-rel="${esc(d.rel)}">
      <span class="tile-top"><span class="tile-badge">diagram</span>${d.components ? `<span class="tile-meta">${d.components} components</span>` : ''}</span>
      <span class="tile-title">${esc(d.title)}</span>
      <span class="tile-note">${esc(d.note)}</span>
      <span class="tile-foot">${esc(d.name.replace(/\.architecture\.html?$/i, ''))} · ${ago(d.mtime)}</span></button>`).join('');
  const doc = r.doc ? `<button class="tile doc" data-v="archdoc" data-rel="${esc(r.doc.rel)}">
      <span class="tile-top"><span class="tile-badge">document</span></span>
      <span class="tile-title">${esc(r.doc.title || 'Architecture document')}</span>
      <span class="tile-note">${esc(r.doc.snippet || '')}</span>
      <span class="tile-foot">${esc(r.doc.name)}</span></button>` : '';
  c.el.innerHTML = `<div class="pv-scroll"><div class="pv-head"><h2>Architecture</h2><span class="pv-path">${esc(r.exists ? r.root : 'architecture/')}</span>
      <span class="grow"></span><button class="btn" data-v="refresh" title="Look for new or regenerated diagrams">↻ Refresh</button></div>
    ${r.exists ? `<div class="tiles">${tiles}${doc}</div>` : `<div class="pv-empty"><h3>No architecture diagrams yet</h3>
      <p>archlens writes one diagram per question, plus a matching document, into <code>docs/architecture/</code> (or <code>architecture/</code>) of this workstream's folder.</p>
      <p>In a Claude session of this workstream, ask: <code>/archlens map the architecture of this project</code></p></div>`}</div>`;
  bind(c.el, (v, b) => {
    if (v === 'refresh') return archHome();
    m.archFile = b.dataset.rel;
    paint();
  });
}

function archViewer(rel) {
  const c = current, ws = c.ws, m = memOf(ws.id);
  c.el.innerHTML = `<div class="pv-bar"><button class="btn" data-v="back">← All diagrams</button><span class="pv-path">${esc(rel)}</span><span class="grow"></span>
    <button class="btn" data-v="prev" title="Previous diagram">‹</button><button class="btn" data-v="next" title="Next diagram">›</button></div>
    <iframe class="pv-frame" sandbox="allow-scripts allow-same-origin allow-popups" src="${esc(viewUrl(ws.id, rel))}" title="${esc(rel)}"></iframe>`;
  bind(c.el, async (v) => {
    if (v === 'back') { m.archFile = null; return paint(); }
    const r = await c.call('archList', { workstreamId: ws.id });
    const i = r.diagrams.findIndex(d => d.rel === rel);
    const n = r.diagrams[(i + (v === 'next' ? 1 : -1) + r.diagrams.length) % r.diagrams.length];
    if (n) { m.archFile = n.rel; paint(); }
  });
}

async function docsHome(dir) {
  const c = current, ws = c.ws, m = memOf(ws.id);
  let r;
  try { r = await c.call('docList', { workstreamId: ws.id, rel: dir }); } catch { if (dir !== 'docs') { m.docDir = 'docs'; return paint(); } return; }
  if (current !== c) return;
  m.docDir = r.rel;
  const crumbs = r.rel.split('/').map((p, i, a) => `${i ? '<span class="sep">/</span>' : ''}${i < a.length - 1 ? `<button class="crumb" data-v="dir" data-rel="${esc(a.slice(0, i + 1).join('/'))}">${esc(p)}</button>` : `<span class="crumb here">${esc(p)}</span>`}`).join('');
  const tiles = r.entries.map(e => e.type === 'dir'
    ? `<button class="tile folder" data-v="dir" data-rel="${esc(e.rel)}"><span class="tile-top"><span class="tile-badge folder">folder</span><span class="tile-meta">${e.count} item${e.count === 1 ? '' : 's'}</span></span><span class="tile-title">📁 ${esc(e.name)}</span><span class="tile-foot">${ago(e.mtime)}</span></button>`
    : `<button class="tile" data-v="file" data-rel="${esc(e.rel)}"><span class="tile-top"><span class="tile-badge">${fileIcon(e.ext)}</span><span class="tile-meta">${e.size < 1024 ? e.size + ' B' : Math.round(e.size / 1024) + ' KB'}</span></span><span class="tile-title">${esc(e.title || e.name)}</span><span class="tile-note">${esc(e.snippet || '')}</span><span class="tile-foot">${e.title ? esc(e.name) + ' · ' : ''}${ago(e.mtime)}</span></button>`).join('');
  c.el.innerHTML = `<div class="pv-scroll"><div class="pv-head"><h2>Docs</h2><span class="crumbs">${crumbs}</span><span class="grow"></span>
      ${r.exists ? '<button class="btn" data-v="new">+ New document</button>' : ''}<button class="btn" data-v="refresh">↻ Refresh</button></div>
    ${!r.exists ? `<div class="pv-empty"><h3>No docs/ folder</h3><p>This workstream's folder has no <code>docs/</code> folder. Documents you put there show up here as tiles.</p></div>`
      : r.entries.length ? `<div class="tiles">${tiles}</div>` : `<div class="pv-empty"><p>This folder is empty.</p></div>`}</div>`;
  bind(c.el, (v, b) => {
    if (v === 'refresh') return docsHome(m.docDir);
    if (v === 'dir') { m.docDir = b.dataset.rel; return docsHome(m.docDir); }
    if (v === 'file') { m.docFile = b.dataset.rel; return paint(); }
    if (v === 'new') return newDoc(r.rel);
  });
}

async function newDoc(dir) {
  const c = current, m = memOf(c.ws.id);
  const name = await c.ask('New document', 'Name (without .md)');
  if (!name || current !== c) return;
  try { const r = await c.call('docCreate', { workstreamId: c.ws.id, rel: dir, name }); m.docFile = r.rel; paint(); } catch {}
}

// A file: Markdown gets preview and edit; HTML and images are shown through the view
// protocol; other text is read-only; anything else is only named.
async function openFile(rel, origin) {
  const c = current, ws = c.ws, m = memOf(ws.id);
  const back = () => { if (!guard()) return; c.dirty = false; if (origin === 'docs') m.docFile = null; else m.archFile = null; paint(); };
  const dir = rel.split('/').slice(0, -1).join('/');
  const bar = extra => `<div class="pv-bar"><button class="btn" data-v="back">← ${origin === 'docs' ? 'Docs' : 'All diagrams'}</button><span class="pv-path">${esc(rel)}</span><span class="grow"></span>${extra || ''}</div>`;
  const onBack = () => bind(c.el, v => { if (v === 'back') back(); });

  if (HTML.test(rel)) {
    c.el.innerHTML = `${bar()}<iframe class="pv-frame" sandbox="allow-scripts allow-same-origin allow-popups" src="${esc(viewUrl(ws.id, rel))}"></iframe>`;
    return onBack();
  }
  if (IMG.test(rel)) {
    c.el.innerHTML = `${bar()}<div class="pv-scroll center"><img class="pv-img" src="${esc(viewUrl(ws.id, rel))}" alt="${esc(rel)}"></div>`;
    return onBack();
  }
  let f;
  try { f = await c.call('docRead', { workstreamId: ws.id, rel }); } catch { return back(); }
  if (current !== c) return;
  if (f.kind === 'binary') {
    c.el.innerHTML = `${bar()}<div class="pv-empty"><h3>${esc(rel.split('/').pop())}</h3><p>This ${esc(f.ext.toUpperCase())} file can't be previewed here.</p></div>`;
    return onBack();
  }
  if (!f.editable) {
    c.el.innerHTML = `${bar()}<div class="pv-scroll"><pre class="md-code pv-text">${esc(f.text)}</pre></div>`;
    return onBack();
  }

  let mode = 'preview', saved = f.text, mtime = f.mtime;
  const isMd = f.kind === 'md';
  c.el.innerHTML = `${bar(`<span class="pv-dirty" hidden>● unsaved</span>
      ${isMd ? '<span class="seg"><button class="btn seg-on" data-v="mode" data-mode="preview">Preview</button><button class="btn" data-v="mode" data-mode="edit">Edit</button></span>' : ''}
      <button class="btn primary" data-v="save" disabled title="Save (Ctrl+S)">Save</button>`)}
    <div class="pv-doc"><textarea class="pv-edit" spellcheck="false" hidden></textarea><article class="pv-md"></article></div>`;
  const ta = c.el.querySelector('.pv-edit'), art = c.el.querySelector('.pv-md'), saveBtn = c.el.querySelector('[data-v=save]'), dirtyEl = c.el.querySelector('.pv-dirty');
  ta.value = f.text;
  const ctx = { wsId: ws.id, dir };
  const draw = () => { art.innerHTML = isMd ? renderMarkdown(ta.value, ctx) : `<pre class="md-code pv-text">${esc(ta.value)}</pre>`; };
  draw();
  const mark = () => { c.dirty = ta.value !== saved; saveBtn.disabled = !c.dirty; dirtyEl.hidden = !c.dirty; };
  let t;
  ta.addEventListener('input', () => { mark(); clearTimeout(t); t = setTimeout(draw, 120); });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); document.execCommand('insertText', false, '  '); }
  });
  const save = async () => {
    if (!c.dirty) return;
    try { await doSave(); } catch {}   // call() has already shown the error
  };
  const doSave = async () => {
    let r = await c.call('docWrite', { workstreamId: ws.id, rel, text: ta.value, mtime });
    if (r.conflict) {
      if (!confirm('This file changed on disk since you opened it (an editor or Claude wrote to it). Overwrite it with your version?')) return;
      r = await c.call('docWrite', { workstreamId: ws.id, rel, text: ta.value, mtime, force: true });
    }
    saved = ta.value; mtime = r.mtime; mark(); c.toast('Saved');
  };
  const setMode = md => {
    mode = md;
    c.el.querySelectorAll('[data-v=mode]').forEach(b => b.classList.toggle('seg-on', b.dataset.mode === md));
    ta.hidden = md !== 'edit' && isMd;
    c.el.querySelector('.pv-doc').classList.toggle('split', md === 'edit');
    if (md === 'edit') ta.focus({ preventScroll: true });
  };
  if (!isMd) { ta.hidden = false; art.hidden = true; c.el.querySelector('.pv-doc').classList.add('split', 'single'); }
  c.el.onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } };
  bind(c.el, (v, b) => {
    if (v === 'back') return back();
    if (v === 'save') return save();
    if (v === 'mode') return setMode(b.dataset.mode);
  });
  // Links inside the document.
  art.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    if (a.dataset.mdExt) return c.call('openLink', { url: a.dataset.mdExt });
    if (a.dataset.mdAnchor) return art.querySelector(`[id="${CSS.escape(a.dataset.mdAnchor)}"]`)?.scrollIntoView();
    if (a.dataset.mdOpen) {
      if (!guard()) return;
      c.dirty = false;
      if (origin === 'docs') { m.docFile = a.dataset.mdOpen; m.docDir = a.dataset.mdOpen.split('/').slice(0, -1).join('/') || 'docs'; } else m.archFile = a.dataset.mdOpen;
      paint();
    }
  });
  void mode;
}
