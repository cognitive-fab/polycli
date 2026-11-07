'use strict';
// A workstream's architecture/ and docs/ folders: listing, reading, editing Markdown,
// and the polycli-view:// protocol that shows HTML diagrams and images from them.
//
// Every path is relative to the workstream folder and must stay inside one of the
// allowed roots (checked on the real path, so a junction or symlink cannot escape).
const fs = require('fs');
const path = require('path');

const ARCH_ROOTS = ['architecture', 'docs/architecture'];
const DOCS_ROOT = 'docs';
const EDITABLE = /\.(md|markdown|txt)$/i;
const TEXTY = /\.(md|markdown|txt|json|ya?ml|csv|log|toml|js|mjs|ts|css)$/i;
const MAX_TEXT = 2 << 20;
const SKIP = /^(\.|node_modules$)/;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

const posix = p => p.replace(/\\/g, '/');
const under = (root, p) => p === root || p.startsWith(root + path.sep);

// rel → absolute path inside `folder`, whose first segments must match one of `roots`.
function resolve(folder, rel, roots) {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new Error('bad path');
  const clean = path.posix.normalize(posix(rel)).replace(/^\/+|\/+$/g, '');
  if (clean.startsWith('..') || path.isAbsolute(clean)) throw new Error('path is outside the project');
  if (!roots.some(r => clean === r || clean.startsWith(r + '/'))) throw new Error('path is outside the allowed folders');
  const full = path.join(folder, clean);
  const realFolder = fs.realpathSync(folder);
  let real;
  try { real = fs.realpathSync(full); } catch { real = path.join(fs.realpathSync(path.dirname(full)), path.basename(full)); }
  if (!under(realFolder, real)) throw new Error('path is outside the project');
  return { rel: clean, full };
}

const DOC_ROOTS = [DOCS_ROOT];
const VIEW_ROOTS = ['architecture', 'docs'];

function head(file, bytes = 2048) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(bytes);
    const n = fs.readSync(fd, b, 0, bytes, 0);
    return b.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function mdSummary(file) {
  try {
    const t = head(file);
    const title = (/^#{1,3}\s+(.+)$/m.exec(t) || [])[1] || null;
    const body = t.replace(/^---[\s\S]*?\n---\s*\n/, '').split(/\r?\n/).find(l => l.trim() && !/^[#>|`\-*!<[]/.test(l.trim()));
    const plain = s => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').trim();
    return { title: title && plain(title), snippet: body ? plain(body).slice(0, 160) : '' };
  } catch { return {}; }
}

function listDir(folder, rel) {
  const { rel: r, full } = resolve(folder, rel || DOCS_ROOT, DOC_ROOTS);
  const st = fs.statSync(full, { throwIfNoEntry: false });
  if (!st) return { exists: false, rel: r, entries: [] };
  if (!st.isDirectory()) throw new Error('not a folder');
  const entries = [];
  for (const d of fs.readdirSync(full, { withFileTypes: true })) {
    if (SKIP.test(d.name)) continue;
    const p = path.join(full, d.name);
    let s; try { s = fs.statSync(p); } catch { continue; }
    if (s.isDirectory()) {
      let n = 0; try { n = fs.readdirSync(p).filter(x => !SKIP.test(x)).length; } catch {}
      entries.push({ name: d.name, rel: `${r}/${d.name}`, type: 'dir', count: n, mtime: s.mtimeMs });
    } else {
      const ext = path.extname(d.name).toLowerCase().slice(1);
      const e = { name: d.name, rel: `${r}/${d.name}`, type: 'file', ext, size: s.size, mtime: s.mtimeMs };
      if (/^(md|markdown)$/.test(ext) && s.size < (1 << 20)) Object.assign(e, mdSummary(p));
      entries.push(e);
    }
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
  return { exists: true, rel: r, entries };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// The diagrams archlens delivered: <name>.architecture.html beside <name>.architecture.json.
// The first root that holds any is the diagram set. README.md / architecture.md beside
// them is the matching architecture document.
function listArchitecture(folder) {
  for (const root of ARCH_ROOTS) {
    let dir;
    try { dir = resolve(folder, root, ARCH_ROOTS).full; } catch { continue; }
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    const diagrams = [];
    for (const n of names.filter(x => /\.architecture\.html?$/i.test(x) && !/\.visual-check\./i.test(x) && !SKIP.test(x)).sort()) {
      const base = n.replace(/\.html?$/i, '');
      const j = readJson(path.join(dir, `${base}.json`));
      const views = j?.meta?.views || [];
      const first = views[0] || {};
      let st; try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
      diagrams.push({
        name: n, rel: `${root}/${n}`,
        title: j?.meta?.title || first.label || base.replace(/\.architecture$/, '').replace(/[_-]+/g, ' '),
        note: /…$/.test(first.note || '') ? first.note.slice(0, -1).replace(/\s+\S{0,3}$/, '') + '…' : first.note || '',
        components: Array.isArray(j?.nodes) ? j.nodes.length : Array.isArray(j?.components) ? j.components.length : null,
        views: views.length || null, mtime: st.mtimeMs,
      });
    }
    if (!diagrams.length) continue;
    const doc = ['README.md', 'architecture.md', 'ARCHITECTURE.md'].find(n => names.includes(n));
    return { exists: true, root, diagrams, doc: doc ? { name: doc, rel: `${root}/${doc}`, ...mdSummary(path.join(dir, doc)) } : null };
  }
  return { exists: false, root: ARCH_ROOTS[0], diagrams: [], doc: null };
}

function readFile(folder, rel) {
  const { rel: r, full } = resolve(folder, rel, VIEW_ROOTS);
  const st = fs.statSync(full);
  if (!st.isFile()) throw new Error('not a file');
  const ext = path.extname(full).toLowerCase();
  if (!TEXTY.test(full)) return { rel: r, kind: 'binary', ext: ext.slice(1), size: st.size, mtime: st.mtimeMs };
  if (st.size > MAX_TEXT) throw new Error('This file is larger than 2 MB; open it in VS Code.');
  return { rel: r, kind: EDITABLE.test(full) ? (/\.txt$/i.test(full) ? 'text' : 'md') : 'text', editable: EDITABLE.test(full), text: fs.readFileSync(full, 'utf8'), mtime: st.mtimeMs };
}

// Saves only text/Markdown files that exist, and refuses when the file changed on disk
// since it was read (an editor or Claude wrote to it) unless `force`.
function writeFile(folder, rel, text, mtime, force) {
  const { rel: r, full } = resolve(folder, rel, VIEW_ROOTS);
  if (!EDITABLE.test(full)) throw new Error('Only Markdown and text files can be edited here');
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error('The text is too large to save');
  const st = fs.statSync(full);
  if (!force && mtime && Math.abs(st.mtimeMs - mtime) > 1) return { conflict: true, mtime: st.mtimeMs };
  const crlf = /\r\n/.test(fs.readFileSync(full, 'utf8'));
  const out = crlf ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
  const tmp = `${full}.polycli.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, full);
  return { rel: r, mtime: fs.statSync(full).mtimeMs };
}

function createDoc(folder, dirRel, name) {
  const n = String(name || '').trim().replace(/\.(md|markdown)$/i, '');
  if (!n || /[\\/:*?"<>|]/.test(n) || n.startsWith('.') || n.length > 80) throw new Error('Give the document a plain name (no slashes or special characters)');
  const { rel: dir, full: dirFull } = resolve(folder, dirRel || DOCS_ROOT, DOC_ROOTS);
  if (!fs.statSync(dirFull, { throwIfNoEntry: false })?.isDirectory()) throw new Error('folder does not exist');
  const { rel, full } = resolve(folder, `${dir}/${n}.md`, DOC_ROOTS);
  if (fs.existsSync(full)) throw new Error(`${n}.md already exists`);
  fs.writeFileSync(full, `# ${n}\n\n`);
  return { rel, mtime: fs.statSync(full).mtimeMs };
}

// Served with a CSP of its own: archlens diagrams carry inline scripts and styles and
// fetch Google Fonts; they get nothing else (no network, no frames, no forms).
const VIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src 'self' data:; media-src 'self'";

// polycli-view://<workstream id>/<path relative to the workstream folder>
function installViewProtocol(protocol, workstreamFolder) {
  protocol.handle('polycli-view', req => {
    const fail = (status, msg) => new Response(msg, { status, headers: { 'content-type': 'text/plain' } });
    try {
      const u = new URL(req.url);
      const folder = workstreamFolder(u.hostname);
      if (!folder) return fail(404, 'unknown workstream');
      const { full } = resolve(folder, decodeURIComponent(u.pathname), VIEW_ROOTS);
      const type = MIME[path.extname(full).toLowerCase()];
      if (!type) return fail(415, 'unsupported file type');
      const body = fs.readFileSync(full);
      return new Response(body, { headers: { 'content-type': type, 'content-security-policy': VIEW_CSP, 'x-content-type-options': 'nosniff' } });
    } catch (e) {
      return fail(404, String(e.message || e));
    }
  });
}

module.exports = { listDir, listArchitecture, readFile, writeFile, createDoc, installViewProtocol };
