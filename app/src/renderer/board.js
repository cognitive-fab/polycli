// The Board view: Ready / Doing / Done columns, drag and drop, and a card drawer with a
// chat (headless Claude in the workstream folder) and links to the documents the card
// produced, which open in the Docs view.
import { renderMarkdown, openDoc } from './views.js';

const api = window.polycli;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLUMNS = [['ready', 'Ready'], ['doing', 'Doing'], ['done', 'Done']];

let ctx = null;            // { el, ws, call, toast, setView } of the view on screen
const st = { cards: [], open: null, messages: [], docs: [], live: null, draft: '' };   // live: { status, texts }

const find = id => st.cards.find(c => c.id === id);

export const leaveBoard = () => { ctx = null; };

export async function boardView(c) {
  ctx = c;
  st.open = null; st.messages = []; st.docs = []; st.live = null;
  c.el.innerHTML = '<div class="pv-scroll"><div class="pv-empty">Loading the board…</div></div>';
  await reload();
}

async function reload() {
  const c = ctx;
  if (!c) return;
  try { st.cards = (await c.call('boardLoad', { workstreamId: c.ws.id })).cards; } catch { return; }
  if (ctx !== c) return;
  paint();
}

function cardHtml(card) {
  const i = COLUMNS.findIndex(([k]) => k === card.column);
  const note = (card.notes || '').split(/\r?\n/).find(l => l.trim() && l.trim() !== card.title) || '';
  return `<div class="kcard ${st.open === card.id ? 'sel' : ''}" draggable="true" data-card="${card.id}">
    <div class="kcard-title">${esc(card.title)}</div>
    ${note ? `<div class="kcard-note">${esc(note.slice(0, 140))}</div>` : ''}
    <div class="kcard-foot">${card.running ? '<span class="kcard-run">● Claude is answering</span>' : card.started ? '<span>💬 chat</span>' : '<span>no chat yet</span>'}
      <span class="grow"></span>
      ${i > 0 ? `<button class="icon-btn" data-k="move" data-to="${COLUMNS[i - 1][0]}" title="Move to ${COLUMNS[i - 1][1]}">‹</button>` : ''}
      ${i < 2 ? `<button class="icon-btn" data-k="move" data-to="${COLUMNS[i + 1][0]}" title="Move to ${COLUMNS[i + 1][1]}">›</button>` : ''}
    </div></div>`;
}

function paint() {
  const c = ctx;
  if (!c) return;
  const cols = COLUMNS.map(([k, label]) => {
    const cards = st.cards.filter(x => x.column === k);
    return `<section class="kcol" data-col="${k}"><header><b>${label}</b><span class="kcount">${cards.length}</span></header>
      ${k === 'ready' ? `<div class="kcompose"><textarea id="kNew" rows="3" placeholder="Describe a task. Claude will talk it through with you and can write the functional spec, the tech spec or a literature search." spellcheck="true">${esc(st.draft)}</textarea>
        <div class="row"><button class="btn" data-k="add">Add card</button><button class="btn primary" data-k="addchat" title="Add the card and start the conversation (Ctrl+Enter)">Add &amp; discuss</button></div></div>` : ''}
      <div class="klist" data-col="${k}">${cards.map(cardHtml).join('') || '<div class="kempty">Nothing here</div>'}</div></section>`;
  }).join('');
  c.el.innerHTML = `<div class="board ${st.open ? 'with-drawer' : ''}"><div class="board-cols">${cols}</div><aside class="kdrawer" ${st.open ? '' : 'hidden'}></aside></div>`;
  if (st.open) paintDrawer();
  wire();
}

// ---------- drag and drop, clicks ----------
function wire() {
  const el = ctx.el;
  const ta = el.querySelector('#kNew');
  if (ta) {
    ta.oninput = () => { st.draft = ta.value; };
    ta.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addCard(true); } };
  }
  let dragId = null;
  el.ondragstart = e => { const k = e.target.closest?.('.kcard'); if (!k) return; dragId = k.dataset.card; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); k.classList.add('dragging'); };
  el.ondragend = () => { dragId = null; el.querySelectorAll('.dragging,.drop').forEach(x => x.classList.remove('dragging', 'drop')); };
  el.ondragover = e => { const l = e.target.closest?.('.kcol'); if (l && dragId) { e.preventDefault(); el.querySelectorAll('.drop').forEach(x => x.classList.remove('drop')); l.classList.add('drop'); } };
  el.ondrop = async e => {
    const col = e.target.closest?.('.kcol');
    if (!col || !dragId) return;
    e.preventDefault();
    const list = col.querySelector('.klist');
    const others = [...list.querySelectorAll('.kcard')].filter(x => x.dataset.card !== dragId);
    let index = others.length;
    for (let i = 0; i < others.length; i++) { const r = others[i].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { index = i; break; } }
    const id = dragId; dragId = null;
    await op({ op: 'move', id, column: col.dataset.col, index });
  };
  el.onclick = async e => {
    const b = e.target.closest('[data-k]');
    if (b) {
      e.stopPropagation();
      const card = b.closest('[data-card]')?.dataset.card;
      switch (b.dataset.k) {
        case 'add': return addCard(false);
        case 'addchat': return addCard(true);
        case 'move': return op({ op: 'move', id: card, column: b.dataset.to });
        case 'close': return closeCard();
        case 'send': return send();
        case 'stop': return ctx.call('boardStop', { workstreamId: ctx.ws.id, id: st.open });
        case 'delete': return deleteCard();
        case 'doc': return openDoc(ctx, b.dataset.rel);
        case 'folder': return;
      }
      return;
    }
    const k = e.target.closest('.kcard');
    if (k) return openCard(k.dataset.card);
  };
}

async function op(a) {
  try { await ctx.call('boardOp', { workstreamId: ctx.ws.id, ...a }); } catch { return; }
  await reload();
}

async function addCard(chat) {
  const text = st.draft.trim();
  if (!text) { ctx.toast('Describe the task first', true); return; }
  let id;
  try { ({ id } = await ctx.call('boardOp', { workstreamId: ctx.ws.id, op: 'add', title: text, notes: text, column: 'ready' })); } catch { return; }
  st.draft = '';
  await reload();
  if (chat) { await openCard(id); await send(text, id); } else toast_added();
}
const toast_added = () => ctx.toast('Card added to Ready');

async function deleteCard() {
  const card = find(st.open);
  if (!card || !confirm(`Delete “${card.title}”? Its documents stay in the project.`)) return;
  try { await ctx.call('boardOp', { workstreamId: ctx.ws.id, op: 'delete', id: card.id }); } catch { return; }
  closeCard();
  await reload();
}

// ---------- the drawer ----------
async function openCard(id) {
  const c = ctx;
  st.open = id; st.live = null; st.messages = []; st.docs = [];
  paint();
  try {
    const [chat, docs] = await Promise.all([c.call('boardChat', { workstreamId: c.ws.id, id }), c.call('boardDocs', { workstreamId: c.ws.id, id })]);
    if (ctx !== c || st.open !== id) return;
    st.messages = chat.messages; st.docs = docs.docs;
    if (chat.running) st.live = { status: 'Claude is answering…', texts: [] };
  } catch { return; }
  paint();
}
function closeCard() { st.open = null; paint(); }

function bubble(m) {
  if (m.role === 'user') return `<div class="msg user">${esc(m.text).replace(/\n/g, '<br>')}</div>`;
  if (m.role === 'error') return `<div class="msg err">${esc(m.text)}</div>`;
  return `<div class="msg bot pv-md">${renderMarkdown(m.text, { wsId: ctx.ws.id, dir: 'docs' })}</div>`;
}

function paintDrawer() {
  const card = find(st.open);
  const d = ctx.el.querySelector('.kdrawer');
  if (!card || !d) return;
  const running = !!st.live;
  d.innerHTML = `<div class="kd-head"><input class="kd-title" value="${esc(card.title)}" maxlength="100" aria-label="Card title">
      <select class="kd-col" aria-label="Column">${COLUMNS.map(([k, l]) => `<option value="${k}" ${k === card.column ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="icon-btn" data-k="delete" title="Delete card">🗑</button><button class="icon-btn" data-k="close" title="Close">✕</button></div>
    <div class="kd-docs"><span class="kd-label">Documents</span>${st.docs.length ? st.docs.map(x => `<button class="doclink" data-k="doc" data-rel="${esc(x.rel)}" title="Open ${esc(x.rel)} in Docs">📄 ${esc(x.title || x.name)}<small>${esc(x.name)}</small></button>`).join('') : `<span class="hint">Specs and research Claude writes for this card show up here (${esc(card.dir)}/).</span>`}</div>
    <div class="kd-chat" id="kChat">${st.messages.map(bubble).join('')}${running ? `<div class="msg status">${esc(st.live.status)}</div>` : ''}${!st.messages.length && !running ? '<div class="hint" style="padding:12px">Say what you want from this card. Try: “Ask me what you need to know, then write the functional spec.”</div>' : ''}</div>
    <div class="kd-input"><textarea id="kMsg" rows="3" placeholder="${running ? 'Claude is answering…' : 'Message Claude about this card (Ctrl+Enter to send)'}" ${running ? 'disabled' : ''}></textarea>
      <div class="row">${running ? '<button class="btn danger" data-k="stop">Stop</button>' : '<button class="btn primary" data-k="send">Send</button>'}</div></div>`;
  const chat = d.querySelector('#kChat');
  chat.scrollTop = chat.scrollHeight;
  const title = d.querySelector('.kd-title');
  title.onchange = () => op({ op: 'update', id: card.id, title: title.value });
  d.querySelector('.kd-col').onchange = e => op({ op: 'move', id: card.id, column: e.target.value });
  const msg = d.querySelector('#kMsg');
  msg.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } };
  if (!running) msg.focus();
}

async function send(text, cardId) {
  const c = ctx, id = cardId ?? st.open;
  const msg = text ?? c.el.querySelector('#kMsg')?.value ?? '';
  if (!msg.trim() || !id) return;
  try { await c.call('boardSend', { workstreamId: c.ws.id, id, text: msg }); } catch { return; }
  if (ctx !== c || st.open !== id) return;   // another card was opened meanwhile; it loads its own chat
  st.messages.push({ role: 'user', text: msg.trim(), at: Date.now() });
  st.live = { status: 'Claude is thinking…', texts: [] };
  paintDrawer();
}

// Events from the main process while Claude answers.
api.onBoard(ev => {
  if (!ctx || ev.workstreamId !== ctx.ws.id) return;
  if (ev.type === 'start') { const k = find(ev.id); if (k) { k.running = true; k.started = true; } return; }
  if (ev.type === 'done') {
    const k = find(ev.id); if (k) k.running = false;
    if (st.open === ev.id) {
      st.live = null;
      Promise.all([ctx.call('boardChat', { workstreamId: ctx.ws.id, id: ev.id }), ctx.call('boardDocs', { workstreamId: ctx.ws.id, id: ev.id })])
        .then(([chat, docs]) => { st.messages = chat.messages; st.docs = docs.docs; paint(); }).catch(() => {});
    } else paint();
    return;
  }
  if (st.open !== ev.id || !st.live) return;
  if (ev.type === 'tool') {
    st.live.status = `Using ${ev.name}${ev.file ? ' · ' + ev.file : ''}…`;
    if (ev.name === 'Write' || ev.name === 'Edit') ctx.call('boardDocs', { workstreamId: ctx.ws.id, id: ev.id }).then(d => { st.docs = d.docs; if (st.live) paintDrawerDocs(); }).catch(() => {});
  } else if (ev.type === 'text') {
    st.messages.push({ role: 'assistant', text: ev.text, at: Date.now(), partial: true });
    st.live.status = 'Claude is writing…';
  }
  paintDrawer();
});

// Only the document links (a file was just written), so a message being typed survives.
function paintDrawerDocs() {
  const box = ctx?.el.querySelector('.kd-docs');
  const card = find(st.open);
  if (!box || !card) return;
  box.innerHTML = `<span class="kd-label">Documents</span>${st.docs.map(x => `<button class="doclink" data-k="doc" data-rel="${esc(x.rel)}" title="Open ${esc(x.rel)} in Docs">📄 ${esc(x.title || x.name)}<small>${esc(x.name)}</small></button>`).join('')}`;
}
