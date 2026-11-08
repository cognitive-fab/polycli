'use strict';
// A Kanban board per workstream: cards in Ready / Doing / Done, each with a chat that
// runs headless Claude (`claude -p`, one conversation per card) in the workstream
// folder. Files, all in the project so they can be committed and Claude can read them:
//   .polycli/board.json          the cards
//   .polycli/cards/<id>.json     the chat shown in the card
//   docs/cards/<id>-<title>/     what Claude writes for the card (specs, literature)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const claude = require('./claude');
const { cleanEnv } = require('./env');
const files = require('./projectfiles');

const COLUMNS = ['ready', 'doing', 'done'];
const MAX_RUNNING = 3;
const MAX_CHAT = 400;
const TOOLS = 'Read,Write,Edit,Glob,Grep,WebSearch,WebFetch';

const now = () => Date.now();
const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'card';
const clip = (s, n) => String(s ?? '').trim().slice(0, n);

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

class Board extends EventEmitter {
  constructor(manager) {
    super();
    this.m = manager;
    this.running = new Map();   // `${workstreamId}:${cardId}` → { child, startedAt }
  }
  folder(wsId) { return this.m.ws(wsId).folder; }
  boardFile(wsId) { return path.join(this.folder(wsId), '.polycli', 'board.json'); }
  chatFile(wsId, id) {
    if (!/^[0-9a-f]{8}$/.test(id)) throw new Error('unknown card');
    return path.join(this.folder(wsId), '.polycli', 'cards', `${id}.json`);
  }
  read(wsId) {
    const b = readJson(this.boardFile(wsId), null);
    return b && Array.isArray(b.cards) ? b : { version: 1, cards: [] };
  }
  card(b, id) {
    const c = b.cards.find(x => x.id === id);
    if (!c) throw new Error('unknown card');
    return c;
  }
  load(wsId) {
    const b = this.read(wsId);
    return { cards: b.cards.map(c => ({ ...c, running: this.running.has(`${wsId}:${c.id}`) })) };
  }

  // add / update / move / delete
  op(wsId, a) {
    const b = this.read(wsId);
    if (a.op === 'add') {
      const title = clip((a.title || '').split(/\r?\n/)[0], 100);
      if (!title) throw new Error('A card needs a title');
      const id = crypto.randomBytes(4).toString('hex');
      b.cards.push({ id, title, notes: clip(a.notes, 20000), column: COLUMNS.includes(a.column) ? a.column : 'ready', session: crypto.randomUUID(), started: false, dir: `docs/cards/${id}-${slug(title)}`, createdAt: now(), updatedAt: now() });
      writeJson(this.boardFile(wsId), b);
      return { id };
    }
    const c = this.card(b, a.id);
    if (a.op === 'update') {
      if (a.title !== undefined) { const t = clip(a.title, 100); if (!t) throw new Error('A card needs a title'); c.title = t; }
      if (a.notes !== undefined) c.notes = clip(a.notes, 20000);
      c.updatedAt = now();
    } else if (a.op === 'move') {
      if (!COLUMNS.includes(a.column)) throw new Error('unknown column');
      b.cards = b.cards.filter(x => x !== c);
      c.column = a.column;
      c.updatedAt = now();
      const inCol = b.cards.map((x, i) => [x, i]).filter(([x]) => x.column === a.column);
      const at = Math.max(0, Math.min(Number.isInteger(a.index) ? a.index : inCol.length, inCol.length));
      const pos = at < inCol.length ? inCol[at][1] : (inCol.length ? inCol[inCol.length - 1][1] + 1 : b.cards.length);
      b.cards.splice(pos, 0, c);
    } else if (a.op === 'delete') {
      if (this.running.has(`${wsId}:${c.id}`)) throw new Error('Stop the chat before deleting the card');
      b.cards = b.cards.filter(x => x !== c);
      try { fs.rmSync(this.chatFile(wsId, c.id), { force: true }); } catch {}   // the documents stay
    } else throw new Error('unknown board operation');
    writeJson(this.boardFile(wsId), b);
    return null;
  }

  chat(wsId, id) {
    const c = readJson(this.chatFile(wsId, id), { messages: [] });
    return { messages: c.messages || [], running: this.running.has(`${wsId}:${id}`) };
  }
  // What Claude has written for the card: the files of its documents folder.
  docs(wsId, id) {
    const c = this.card(this.read(wsId), id);
    const out = [];
    const walk = (rel, depth) => {
      let r;
      try { r = files.listDir(this.folder(wsId), rel); } catch { return; }
      for (const e of r.entries) {
        if (e.type === 'file') out.push({ name: e.name, rel: e.rel, title: e.title || null, ext: e.ext, mtime: e.mtime });
        else if (depth < 2) walk(e.rel, depth + 1);
      }
    };
    walk(c.dir, 0);
    return { dir: c.dir, docs: out };
  }

  saveChat(wsId, id, messages) {
    writeJson(this.chatFile(wsId, id), { messages: messages.slice(-MAX_CHAT) });
  }

  send(wsId, id, text) {
    const w = this.m.liveWs(wsId);
    const exe = claude.exe();   // throws, before anything is saved, when claude is not on PATH
    const key = `${wsId}:${id}`;
    if (this.running.has(key)) throw new Error('Claude is still answering on this card');
    if ([...this.running.keys()].filter(k => k.startsWith(`${wsId}:`)).length >= MAX_RUNNING) throw new Error(`At most ${MAX_RUNNING} cards can chat at once`);
    const msg = clip(text, 50000);
    if (!msg) throw new Error('Write a message first');
    const b = this.read(wsId);
    const card = this.card(b, id);
    const first = !card.started;
    card.started = true;
    card.updatedAt = now();
    writeJson(this.boardFile(wsId), b);
    const messages = this.chat(wsId, id).messages;
    messages.push({ role: 'user', text: msg, at: now() });
    this.saveChat(wsId, id, messages);

    const system = [
      `You are helping the user shape one card on their Kanban board: "${card.title}".`,
      card.notes ? `The card's notes:\n${card.notes}` : '',
      'Talk it through first: ask short, pointed questions about scope and constraints before producing anything long.',
      `When the task is clear, or when asked, write deliverables as Markdown files in ${card.dir}/ (for example functional-spec.md, tech-spec.md, literature.md; use WebSearch for a literature search and cite sources with links). Tell the user which files you wrote.`,
      'Do not run shell commands and do not change other project files unless the user explicitly asks.',
    ].filter(Boolean).join('\n\n');
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', TOOLS,
      '--append-system-prompt', system, ...(first ? ['--session-id', card.session] : ['--resume', card.session])];
    let extra = {};
    try { extra = this.m.envFor(w); } catch {}
    const child = spawn(exe, args, { cwd: w.folder, env: cleanEnv(extra), windowsHide: true });
    this.running.set(key, { child, startedAt: now() });
    this.emit('event', { workstreamId: wsId, id, type: 'start' });

    const parts = [];
    let buf = '', err = '', result = null;
    const onLine = line => {
      let o; try { o = JSON.parse(line); } catch { return; }
      if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
        for (const blk of o.message.content) {
          if (blk.type === 'text' && blk.text) { parts.push(blk.text); this.emit('event', { workstreamId: wsId, id, type: 'text', text: blk.text }); }
          else if (blk.type === 'tool_use') this.emit('event', { workstreamId: wsId, id, type: 'tool', name: blk.name, file: clip(blk.input?.file_path || blk.input?.query || blk.input?.url || '', 120) });
        }
      } else if (o.type === 'result') result = o;
    };
    child.stdout.on('data', d => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (l) onLine(l); }
    });
    child.stderr.on('data', d => { err = (err + d.toString('utf8')).slice(-4000); });
    child.on('error', e => { err = String(e.message || e); });
    child.on('close', code => {
      if (buf.trim()) onLine(buf.trim());
      const stopped = this.running.get(key)?.stopped;
      this.running.delete(key);
      const reply = parts.join('\n\n').trim() || (result && typeof result.result === 'string' ? result.result.trim() : '');
      const msgs = this.chat(wsId, id).messages;
      let error = null;
      if (stopped) error = 'Stopped.';
      else if (code !== 0 && !reply) error = (result?.result && String(result.result)) || err.trim().split(/\r?\n/).slice(-3).join(' ') || `claude exited with code ${code}`;
      else if (result?.is_error && !reply) error = String(result.result || 'Claude reported an error');
      if (reply) msgs.push({ role: 'assistant', text: reply, at: now() });
      if (error) msgs.push({ role: 'error', text: error, at: now() });
      this.saveChat(wsId, id, msgs);
      this.emit('event', { workstreamId: wsId, id, type: 'done', error });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(msg);
  }

  stop(wsId, id) {
    const r = this.running.get(`${wsId}:${id}`);
    if (!r) return;
    r.stopped = true;
    execFile('taskkill.exe', ['/pid', String(r.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  }
  dispose() { for (const [k, r] of this.running) { r.stopped = true; try { r.child.kill(); } catch {} this.running.delete(k); } }
}

module.exports = { Board, COLUMNS };
