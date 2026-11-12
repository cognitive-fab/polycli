'use strict';
// The Artifacts view of a workstream: one list of what its Cowork tasks reported
// (polycli_add_artifact) and what its Claude sessions made: pages published with Claude
// Code's Artifact tool (claude.ai links) and documents they wrote (Markdown, HTML, PDF…).
//
// Sessions report through the PostToolUse hook as they work (sessions.js keeps
// `links` and `documents` on each session); their transcripts are also read, so what a
// session made before polycli watched it shows up too.
//
// The renderer only ever names an item by its id: links, paths and files are looked up
// here again, so a page can't make polycli open or serve something that isn't listed.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DOC_EXT = /\.(md|markdown|html?|pdf|docx?|pptx?|xlsx?|csv|txt|svg|png|jpe?g|gif|webp)$/i;
const CLAUDE_ARTIFACT = /^https:\/\/claude\.ai\/(code\/)?artifact\/[\w-]+$/;
const MAX_ITEMS = 500;
const TMP = require('os').tmpdir();

// Shown inside polycli (the protocol below); anything else is offered in its folder.
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8', '.markdown': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
};
// Like the docs viewer: a page runs its own scripts and styles, but reaches nothing
// outside the files beside it (no network, no frames, no forms).
const VIEW_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; media-src 'self'";

const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const fileKey = p => path.resolve(p).toLowerCase();

// From a PostToolUse hook or a transcript: the claude.ai page an Artifact publish made.
// tool_response is the tool's result object ({ url, title, path, icon, … }); older
// Claude Code versions may give the text instead ("Published <path> at <url> …").
function publishedArtifact(toolName, response) {
  if (toolName !== 'Artifact' || !response) return null;
  if (typeof response === 'object' && !Array.isArray(response)) {
    if (typeof response.url !== 'string' || !CLAUDE_ARTIFACT.test(response.url)) return null;
    return { url: response.url, title: str(response.title, 200), path: str(response.path, 1000), icon: str(response.icon, 40) };
  }
  const text = Array.isArray(response) ? response.map(c => (typeof c === 'string' ? c : c?.text || '')).join('\n') : String(response);
  const m = /^Published (.+?) at (https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+)/m.exec(text);
  return m ? { url: m[2], title: null, path: m[1], icon: null } : null;
}
const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

class Artifacts {
  constructor(manager, cowork) {
    this.manager = manager;
    this.cowork = cowork;
    this.scans = new Map();   // transcript path → { offset, links: Map(url → item), docs: Map(key → item) }
  }

  // Everything for one workstream, newest first. `rescan` reads what the transcripts
  // gained since the last look.
  async list(wsId, { rescan = false } = {}) {
    const ws = this.manager.ws(wsId);
    const sessions = this.manager.state.sessions.filter(s => s.workstreamId === ws.id);
    if (rescan) for (const s of sessions) if (s.transcriptPath) await this.scan(s.transcriptPath).catch(() => {});
    const byUrl = new Map(), byPath = new Map();
    const add = it => {
      const k = it.url || fileKey(it.path);
      const map = it.url ? byUrl : byPath;
      const old = map.get(k);
      if (old) {
        if ((it.at || 0) > (old.at || 0)) old.at = it.at;
        old.title = old.title || it.title;
        old.path = old.path || it.path;
        old.description = old.description || it.description;
        return;
      }
      map.set(k, { ...it });
    };
    for (const a of this.cowork.c.artifacts.filter(x => x.workstreamId === ws.id)) {
      const link = this.cowork.c.links.find(l => l.id === a.linkId);
      add({ source: 'cowork', from: link?.title || 'Cowork task', title: a.title, kind: a.kind, url: a.url, path: a.path, description: a.description, at: a.at });
    }
    for (const s of sessions) {
      const scan = s.transcriptPath && this.scans.get(s.transcriptPath);
      for (const l of [...(s.links || []), ...(scan ? scan.links.values() : [])]) add({ source: 'session', from: s.name, title: l.title, kind: 'claude.ai artifact', url: l.url, path: l.path, at: l.at });
      for (const d of [...(s.documents || []), ...(scan ? scan.docs.values() : [])]) add({ source: 'session', from: s.name, title: null, kind: kindOf(d.path), url: null, path: d.path, at: d.at });
    }
    // A published page's local copy is the same artifact: one row, with both.
    for (const it of byUrl.values()) if (it.path) byPath.delete(fileKey(it.path));
    const items = [...byUrl.values(), ...byPath.values()].map(it => {
      const id = it.url ? `u${hash(it.url)}` : `f${hash(fileKey(it.path))}`;
      const st = it.path ? fs.statSync(it.path, { throwIfNoEntry: false }) : null;
      const ext = it.path ? path.extname(it.path).toLowerCase() : '';
      return {
        id, ...it,
        title: it.title || (it.path ? path.basename(it.path) : it.url),
        exists: it.path ? !!st?.isFile() : null,
        viewable: !!(st?.isFile() && MIME[ext]),
        markdown: /^\.(md|markdown)$/.test(ext),
        inFolder: it.path ? under(ws.folder, it.path) : false,
      };
    });
    items.sort((a, b) => (b.at || 0) - (a.at || 0));
    return { items: items.slice(0, MAX_ITEMS) };
  }

  // `cached`: a page loading its images asks once per file; the list of the last few
  // seconds answers those.
  async item(wsId, id, { cached = false } = {}) {
    const c = this.lastList;
    const list = cached && c && c.wsId === wsId && Date.now() - c.at < 5000 ? c.list : await this.list(wsId);
    if (!c || list !== c.list) this.lastList = { wsId, at: Date.now(), list };
    const it = list.items.find(x => x.id === id);
    if (!it) throw new Error('This artifact is no longer listed');
    return it;
  }

  // New lines of a transcript since the last scan (it only grows; a shorter file was
  // rewritten, so it is read again from the start).
  async scan(file) {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    let s = this.scans.get(file);
    if (!s || st.size < s.offset) s = { offset: 0, links: new Map(), docs: new Map() };
    if (st.size === s.offset) return this.scans.set(file, s);
    const rl = readline.createInterface({ input: fs.createReadStream(file, { start: s.offset, end: st.size - 1, encoding: 'utf8' }), crlfDelay: Infinity });
    let read = s.offset, last = s.offset;
    for await (const line of rl) {
      read += Buffer.byteLength(line, 'utf8') + 1;
      if (line.includes('"Artifact"') || line.includes('claude.ai/') || line.includes('"file_path"')) scanLine(line, s);
      last = read;
    }
    s.offset = Math.min(last, st.size);
    this.scans.set(file, s);
  }
}

function scanLine(line, s) {
  let j;
  try { j = JSON.parse(line); } catch { return; }
  const at = Date.parse(j.timestamp) || null;
  const r = j.toolUseResult;
  // An Artifact publish result: { url, title, path, … } (a listing has `artifacts` instead).
  if (r && typeof r === 'object' && typeof r.url === 'string' && CLAUDE_ARTIFACT.test(r.url) && !Array.isArray(r.artifacts)) {
    s.links.set(r.url, { url: r.url, title: str(r.title, 200), path: str(r.path, 1000), at });
    return;
  }
  if (j.type !== 'assistant' || !Array.isArray(j.message?.content)) return;
  for (const c of j.message.content) {
    if (c?.type !== 'tool_use' || !['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(c.name)) continue;
    const f = c.input?.file_path;
    // Not Claude's own files (~/.claude: plans, memory, skills) nor scratch files in the
    // temp folder (a published page's copy there comes with its link above).
    if (typeof f === 'string' && path.isAbsolute(f) && DOC_EXT.test(f) && !/[\\/]\.claude[\\/](?!worktrees)/.test(f) && !under(TMP, f)) s.docs.set(fileKey(f), { path: f, at });
  }
}

function kindOf(p) {
  const e = path.extname(p || '').toLowerCase().slice(1);
  return ({ md: 'Markdown', markdown: 'Markdown', html: 'HTML page', htm: 'HTML page', pdf: 'PDF', docx: 'Word', doc: 'Word', pptx: 'PowerPoint', ppt: 'PowerPoint', xlsx: 'Excel', xls: 'Excel', csv: 'CSV', txt: 'Text' }[e]) || (/^(png|jpe?g|gif|webp|svg)$/.test(e) ? 'Image' : 'File');
}
function under(folder, p) {
  const a = fileKey(folder), b = fileKey(p);
  return b === a || b.startsWith(a + path.sep);
}

// polycli-art://<workstream id>/<item id>/<file>[/<files beside it>]: an artifact file
// and the files next to it (a page's images and scripts), read only from the folder the
// listed file is in.
function installArtifactProtocol(protocol, artifacts) {
  protocol.handle('polycli-art', async req => {
    const fail = (status, msg) => new Response(msg, { status, headers: { 'content-type': 'text/plain' } });
    try {
      const u = new URL(req.url);
      // /<item id>/<file name>, and the page's own relative links resolve beside it.
      const [itemId, ...rest] = u.pathname.replace(/^\/+/, '').split('/').map(decodeURIComponent);
      if (!rest.length || rest.some(p => !p || p === '..' || p === '.' || /[\\/\0]/.test(p))) return fail(400, 'bad path');
      const it = await artifacts.item(u.hostname, itemId, { cached: true });
      if (!it.path || !it.exists) return fail(404, 'The file is no longer there');
      const dir = fs.realpathSync(path.dirname(it.path));
      const wanted = path.join(dir, ...rest);
      const real = fs.realpathSync(wanted);
      if (!(real === dir || real.startsWith(dir + path.sep))) return fail(403, 'outside the artifact folder');
      const type = MIME[path.extname(real).toLowerCase()];
      if (!type) return fail(415, 'unsupported file type');
      return new Response(fs.readFileSync(real), { headers: { 'content-type': type, 'content-security-policy': VIEW_CSP, 'x-content-type-options': 'nosniff' } });
    } catch (e) {
      return fail(404, String(e.message || e));
    }
  });
}

module.exports = { Artifacts, publishedArtifact, installArtifactProtocol, CLAUDE_ARTIFACT };
