'use strict';
// POLYCLI_SMOKE=1: drives the real app through the Phase 1 flow and writes
// out/smoke.json plus screenshots. It uses Haiku in a scratch trusted folder and
// removes everything it created.
const fs = require('fs');
const path = require('path');
const claude = require('./claude');
const vscode = require('./vscode');

const OUT = path.join(__dirname, '..', '..', 'out');
const FOLDER = process.env.POLYCLI_SMOKE_FOLDER;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = pred();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

// Crash test, phase 1: start a session, report the main pid, and wait to be killed.
async function runLaunch({ manager }) {
  const ws = manager.createWorkstream({ name: 'persist-test', folder: FOLDER });
  const s = await manager.newSession({ workstreamId: ws.id, role: 'survivor', model: 'haiku' });
  await waitFor(() => manager.session(s.id).state === 'idle' && manager.pty.isLive(`s:${s.id}`), 60000, 'idle');
  fs.writeFileSync(path.join(OUT, 'persist.json'), JSON.stringify({ mainPid: process.pid, bgId: s.bgId, sessionId: s.id }));
}

// Crash test, phase 2: after a hard kill and a fresh start, the session must be
// reattached from polycli's own state and still answer.
async function runVerify({ app, manager }) {
  const report = { phase: 'verify' };
  const { sessionId } = JSON.parse(fs.readFileSync(path.join(OUT, 'persist.json'), 'utf8'));
  try {
    const S = () => manager.session(sessionId);
    await waitFor(() => manager.pty.isLive(`s:${sessionId}`), 10000, 'reattach pty');
    await waitFor(() => S().state === 'idle', 60000, 'idle after restore');
    report.reattached = true;
    report.registered = await manager.submitPrompt(sessionId, 'Reply with exactly the word PONG3 and nothing else.');
    await waitFor(() => (S().lastMessage || '').includes('PONG3') && S().state === 'idle', 90000, 'answer');
    report.answer = S().lastMessage;
    report.ok = true;
  } catch (e) {
    report.ok = false;
    report.error = String(e.stack || e);
    report.session = manager.snapshot().sessions.find(x => x.id === sessionId);
  }
  try { await manager.deleteSession(sessionId); } catch {}
  fs.writeFileSync(path.join(OUT, 'persist-verify.json'), JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}

// Needs-you path: a session in default permission mode asked to run a command must
// raise a permission prompt → Notification hook → needs-you → inbox and toast.
async function runNeeds({ app, win, manager }) {
  const report = { phase: 'needs' };
  let sid = null;
  try {
    const ws = manager.createWorkstream({ name: 'needs-test', folder: FOLDER });
    const s = await manager.newSession({ workstreamId: ws.id, role: 'perm', model: 'haiku', permissionMode: 'default' });
    sid = s.id;
    const S = () => manager.session(sid);
    await waitFor(() => S().state === 'idle' && manager.pty.isLive(`s:${sid}`), 60000, 'idle');
    report.registered = await manager.submitPrompt(sid, 'Use the Bash tool to run exactly this command: mkdir polycli-permission-probe');
    await waitFor(() => S().state === 'needs-you', 90000, 'needs-you');
    report.state = S().state;
    report.attention = S().attention;
    report.notificationPayload = S().lastNotification;
    report.inboxCount = manager.snapshot().sessions.filter(x => x.state === 'needs-you').length;
    await sleep(1500);
    report.toast = global.polycliLastToast || null;
    await sleep(600);
    fs.writeFileSync(path.join(OUT, 'needs-you.png'), (await win.webContents.capturePage()).toPNG());
    manager.write(`s:${sid}`, '\x1b');   // Esc: decline the permission prompt
    await sleep(1500);
    report.ok = true;
  } catch (e) {
    report.ok = false;
    report.error = String(e.stack || e);
    if (sid) report.session = manager.snapshot().sessions.find(x => x.id === sid);
    if (sid) report.screen = manager.pty.scrollback(`s:${sid}`).slice(-2500);
  }
  if (sid) { try { await manager.deleteSession(sid); } catch {} }
  fs.writeFileSync(path.join(OUT, 'needs-you.json'), JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}

// Copy/paste with real mouse and keyboard input on an attached session: drag to
// select, Ctrl+C must copy and must not clear the typed prompt; Ctrl+V pastes once.
async function runClip({ app, win, manager }) {
  const { clipboard } = require('electron');
  const report = { phase: 'clip', cases: [] };
  let sid = null;
  const wc = win.webContents;
  const screenText = () => manager.pty.scrollback(`s:${sid}`).slice(-4000)
    .replace(/\x1b\[[0-9;?<>=]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b.)/g, '');
  const key = (k, modifiers) => { wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers }); };
  const mouse = (type, x, y, extra = {}) => wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
  try {
    const ws = manager.createWorkstream({ name: 'clip-test', folder: FOLDER });
    // Workstream environment: stored encrypted, written into the session's settings
    // file, and given to shells.
    manager.updateWorkstream({ id: ws.id, env: [{ name: 'POLYCLI_SMOKE_VAR', value: 'smoke-value-7' }] });
    require('./store').flush();
    const stateRaw = fs.readFileSync(path.join(process.env.POLYCLI_HOME, 'data', 'state.json'), 'utf8');
    report.env = { plaintextInState: stateRaw.includes('smoke-value-7'), plaintextInSnapshot: JSON.stringify(manager.snapshot()).includes('smoke-value-7') };
    const s = await manager.newSession({ workstreamId: ws.id, role: 'clip', model: 'haiku' });
    report.env.settingsEnv = JSON.parse(fs.readFileSync(path.join(process.env.POLYCLI_HOME, 'run', `${s.id}.settings.json`), 'utf8')).env;
    const sh = manager.newShell({ workstreamId: ws.id });
    await sleep(2500);
    manager.write(`h:${sh.id}`, 'echo "VAR=$env:POLYCLI_SMOKE_VAR"\r');
    await waitFor(() => manager.pty.scrollback(`h:${sh.id}`).includes('VAR=smoke-value-7'), 15000, 'shell env').catch(() => {});
    report.env.shell = manager.pty.scrollback(`h:${sh.id}`).includes('VAR=smoke-value-7');
    await manager.closeShell(sh.id);
    console.log('SMOKE env', JSON.stringify(report.env));
    sid = s.id;
    // Record what the pane sends to the session (keys and mouse reports).
    const sent = report.sent = [];
    const write = manager.write.bind(manager);
    manager.write = (term, data) => { if (term === `s:${sid}`) sent.push(JSON.stringify(data).slice(1, -1).replace(/\\u001b/g, 'ESC')); return write(term, data); };
    await waitFor(() => manager.session(sid).state === 'idle' && manager.pty.isLive(`s:${sid}`), 60000, 'idle');
    await sleep(1500);
    win.show(); win.focus(); wc.focus();
    manager.setUi({ activeTab: `s:${sid}` });   // the test shell took the active tab
    for (let i = 0; i < 40; i++) {
      if (await wc.executeJavaScript(`!!document.querySelector('[data-term="s:${sid}"] .xterm-screen')?.offsetParent`)) break;
      await sleep(250);
    }
    const rect = await wc.executeJavaScript(`(() => { const r = document.querySelector('[data-term="s:${sid}"] .xterm-screen').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    report.rect = rect;
    await wc.executeJavaScript(`document.querySelector('[data-term="s:${sid}"] textarea').focus()`);

    // Type into the prompt, find that text on screen, drag across it, press Ctrl+C.
    // Right after an attach Claude can drop typed input, so retry until it shows.
    const findTyped = () => wc.executeJavaScript(`(() => {
      const e = window.__polycli.terms.get('s:${sid}'); if (!e) return { missing: [...window.__polycli.terms.keys()] }; const t = e.term, b = t.buffer.active;
      for (let y = 0; y < t.rows; y++) { const l = b.getLine(b.viewportY + y)?.translateToString() || ''; const x = l.indexOf('KEEPME'); if (x >= 0) return { x, y, cols: t.cols, rows: t.rows }; }
      return null; })()`);
    let at = null;
    for (let i = 0; i < 5 && !at; i++) {
      manager.write(`s:${sid}`, '\x15KEEPME prompt text');
      await sleep(1500);
      at = await findTyped();
      if (at?.missing) throw new Error(`pane terminal not mounted; mounted: ${at.missing.join(', ')}`);
    }
    await clipboard.writeText('BEFORE');
    if (!at) {
      report.screenLines = await wc.executeJavaScript(`(() => { const t = window.__polycli.terms.get('s:${sid}').term, b = t.buffer.active; const out = [b.type + ' vy=' + b.viewportY + ' rows=' + t.rows]; for (let y = 0; y < t.rows; y++) out.push(b.getLine(b.viewportY + y)?.translateToString(true) || ''); return out; })()`);
      report.tail = screenText().slice(-600);
      fs.writeFileSync(path.join(OUT, 'clip-error.png'), (await wc.capturePage()).toPNG());
      throw new Error('typed text not found on screen');
    }
    const cw = rect.w / at.cols, ch = rect.h / at.rows;
    const px = col => rect.x + (col + 0.5) * cw, py = rect.y + (at.y + 0.5) * ch;
    const sentBefore = report.sent.length;
    mouse('mouseDown', px(at.x), py);
    for (let i = 1; i <= 6; i++) mouse('mouseMove', px(at.x + i), py, { modifiers: ['leftButtonDown'] });
    mouse('mouseUp', px(at.x + 6), py);
    await sleep(500);
    const selection = await wc.executeJavaScript(`window.__polycli.terms.get('s:${sid}')?.term.getSelection() ?? 'NO TERM: ' + [...window.__polycli.terms.keys()].join(',')`);
    key('C', ['control']);
    await sleep(1200);
    const sentDuring = report.sent.slice(sentBefore).filter(x => !/^ESC\[[IO]$/.test(x));
    const c = { name: 'drag-then-ctrl-c', selection, clipboard: String(await clipboard.readText()).slice(0, 60), sentToClaude: sentDuring };
    report.cases.push(c);
    console.log('SMOKE clip', JSON.stringify(c));
    fs.writeFileSync(path.join(OUT, 'clip-select.png'), (await wc.capturePage()).toPNG());
    // Without a selection, Ctrl+C still reaches Claude.
    const before2 = report.sent.length;
    key('C', ['control']);
    await sleep(600);
    report.ctrlCWithoutSelection = report.sent.slice(before2).includes('\\u0003');   // the log holds JSON-escaped text
    console.log('SMOKE ctrl-c without selection reaches claude', report.ctrlCWithoutSelection);
    manager.write(`s:${sid}`, '\x15');
    await sleep(500);

    // Paste: must arrive exactly once.
    await clipboard.writeText('PASTEONCE');
    const mark = manager.pty.scrollback(`s:${sid}`).length;
    key('V', ['control']);
    await sleep(1500);
    const tail = manager.pty.scrollback(`s:${sid}`).slice(mark).replace(/\x1b\[[0-9;?<>=]*[a-zA-Z]/g, '');
    report.paste = { count: tail.split('PASTEONCE').length - 1, sent: report.sent.filter(x => x.includes('PASTEONCE')).length, screen: screenText().slice(-300) };
    console.log('SMOKE paste', JSON.stringify({ shown: report.paste.count, sent: report.paste.sent }));

    // The wheel still reaches Claude as SGR wheel reports.
    wc.sendInputEvent({ type: 'mouseWheel', x: Math.round(rect.x + 200), y: Math.round(rect.y + 200), deltaX: 0, deltaY: 120 });
    await sleep(600);
    report.wheel = report.sent.filter(x => /ESC\[<6[45];/.test(x)).length;
    console.log('SMOKE wheel', report.wheel);
    const c1 = report.cases[0];
    const e = report.env;
    report.ok = !e.plaintextInState && !e.plaintextInSnapshot && e.settingsEnv?.POLYCLI_SMOKE_VAR === 'smoke-value-7' && e.shell &&
      c1.clipboard.startsWith('KEEPME') && c1.sentToClaude.length === 0 && report.ctrlCWithoutSelection && report.paste.sent === 1 && report.wheel > 0;
  } catch (e) {
    report.ok = false;
    report.error = String(e.stack || e);
  }
  if (sid) { try { await manager.deleteSession(sid); } catch {} }
  fs.writeFileSync(path.join(OUT, 'clip.json'), JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}

// Screenshots of the workstream settings and Keys dialogs (no Claude session needed).
async function runUi({ app, win, manager }) {
  const report = { phase: 'ui' };
  const wc = win.webContents;
  const shot = async name => { await sleep(700); fs.writeFileSync(path.join(OUT, `ui-${name}.png`), (await wc.capturePage()).toPNG()); };
  try {
    const ws = manager.createWorkstream({ name: 'ui-test', folder: FOLDER });
    manager.updateWorkstream({ id: ws.id, env: [{ name: 'POLYWORLD_API_KEY', value: 'x' }, { name: 'MY_SERVICE_URL', value: 'y' }], uses: ['FRED_API_KEY'] });
    await sleep(800);
    await wc.executeJavaScript(`document.querySelector('[data-act="wsSettings"]').click()`);
    await sleep(800);
    await wc.executeJavaScript(`(() => { document.querySelector('#envAdd').click(); const r = [...document.querySelectorAll('.env-row')].pop(); r.querySelector('.env-name').value = 'ANTHROPIC_API_KEY'; r.querySelector('.env-name').dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await shot('settings');
    report.settingsRows = await wc.executeJavaScript(`document.querySelectorAll('.env-row').length`);
    report.warning = await wc.executeJavaScript(`document.querySelector('#envWarn').textContent`);
    await wc.executeJavaScript(`document.querySelector('[data-cancel]').click()`);
    await wc.executeJavaScript(`document.querySelector('#keysBtn').click()`);
    await sleep(800);
    await shot('keys');
    report.keyRows = await wc.executeJavaScript(`document.querySelectorAll('.keys-table tbody tr').length`);
    await wc.executeJavaScript(`document.querySelector('[data-cancel]').click()`);
    // Archive from Settings, then restore from the Archived list.
    const keep = manager.createWorkstream({ name: 'ui-keep', folder: FOLDER });
    manager.setActive(ws.id);
    manager.newShell({ workstreamId: ws.id });
    await sleep(800);
    await wc.executeJavaScript(`document.querySelector('[data-act="wsSettings"]').click()`);
    await sleep(800);
    await wc.executeJavaScript(`document.querySelector('#wsArchive').click()`);
    await sleep(500);
    report.archiveText = await wc.executeJavaScript(`document.querySelector('#modal p').textContent`);
    await wc.executeJavaScript(`document.querySelector('#modal .modal-actions .primary').click()`);
    await waitFor(() => manager.ws(ws.id).archived, 10000, 'archived');
    await sleep(600);
    await wc.executeJavaScript(`document.querySelector('[data-archived-toggle]').click()`);
    await shot('archived');
    report.rail = await wc.executeJavaScript(`[...document.querySelectorAll('#wsList .ws-name')].map(e => e.textContent)`);
    report.archivedShells = manager.state.shells.filter(h => h.workstreamId === ws.id).length;
    report.activeAfterArchive = manager.state.ui.activeWorkstream === keep.id;
    await wc.executeJavaScript(`document.querySelector('[data-restore-ws]').click()`);
    await waitFor(() => !manager.ws(ws.id).archived, 10000, 'restored');
    report.ok = report.settingsRows === 3 && /ANTHROPIC_API_KEY/.test(report.warning) && report.keyRows > 0
      && /1 shell/.test(report.archiveText) && report.archivedShells === 0 && report.activeAfterArchive
      && report.rail.join() === 'ui-keep,ui-test';
  } catch (e) {
    report.ok = false;
    report.error = String(e.stack || e);
  }
  fs.writeFileSync(path.join(OUT, 'ui.json'), JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}

// Git line and themes on a real session, read-only: the smoke folder sits inside the
// polycli repo, so this mode never clicks Commit or Push (it only opens and cancels
// the Commit dialog).
async function runGit({ app, win, manager }) {
  const report = { phase: 'git', shots: [] };
  const wc = win.webContents;
  const shot = async name => {
    await sleep(900);
    try { fs.writeFileSync(path.join(OUT, `git-${name}.png`), (await wc.capturePage()).toPNG()); report.shots.push(name); }
    catch (e) { report.shots.push(`${name}: not captured (${e.message || e})`); }
  };
  let sid = null;
  try {
    const ws = manager.createWorkstream({ name: 'git-test', folder: FOLDER });
    const s = await manager.newSession({ workstreamId: ws.id, role: 'main', model: 'haiku' });
    sid = s.id;
    await waitFor(() => manager.session(sid).state === 'idle' && manager.pty.isLive(`s:${sid}`), 60000, 'idle');
    await manager.refreshGit(FOLDER, { pr: true });
    await waitFor(() => manager.snapshot().sessions.find(x => x.id === sid).git, 15000, 'git line');
    report.git = manager.snapshot().sessions.find(x => x.id === sid).git;
    await sleep(1500);
    report.gitLine = await wc.executeJavaScript(`document.querySelector('[data-session="${sid}"] .l4')?.innerText || null`);
    await shot('dark');
    await wc.executeJavaScript(`document.querySelector('[data-session="${sid}"] [data-act="git-commit"]')?.click()`);
    await sleep(1500);
    report.commitDialogFiles = await wc.executeJavaScript(`document.querySelectorAll('.file-list > div').length`);
    await shot('commit-dialog');
    await wc.executeJavaScript(`document.querySelector('[data-cancel]')?.click()`);
    manager.setUi({ theme: 'light' });
    await sleep(1200);
    report.themeLight = await wc.executeJavaScript(`document.documentElement.dataset.theme`);
    await shot('light');
    manager.setUi({ theme: 'system' });
    report.ok = !!report.gitLine && report.themeLight === 'light' && report.commitDialogFiles >= 0;
  } catch (e) {
    report.ok = false;
    report.error = String(e.stack || e);
  }
  if (sid) { try { await manager.deleteSession(sid); } catch {} }
  fs.writeFileSync(path.join(OUT, 'git.json'), JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}

// Screenshots for resources/help (HELP.md). Demo workstreams in a folder inside the
// trusted smoke area; the Keys list is a demo list, never this machine's variables.
// Also checks that the terminal's last row isn't clipped.
async function runHelp({ app, win, manager }) {
  const report = { phase: 'help', shots: [] };
  const wc = win.webContents;
  const HELP = path.join(__dirname, '..', '..', 'resources', 'help');
  const shot = async (name, selector) => {
    await sleep(900);
    try {
      let rect;
      if (selector) {
        rect = await wc.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`);
      }
      const img = await wc.capturePage(rect);
      fs.writeFileSync(path.join(HELP, `${name}.png`), img.toPNG());
      report.shots.push(name);
    } catch (e) { report.shots.push(`${name}: not captured (${e.message || e})`); }
  };
  require('./env').globalKeys = async () => ['GITHUB_TOKEN', 'MAPS_API_KEY', 'SENTRY_AUTH_TOKEN', 'STRIPE_SECRET_KEY'].map(name => ({ name, scope: 'user' }));
  const sids = [];
  try {
    const demo = path.join(path.dirname(FOLDER), 'acme-api');
    fs.mkdirSync(demo, { recursive: true });
    win.setSize(1400, 860);
    manager.createWorkstream({ name: 'docs-site', folder: demo, color: '#4cc38a' });
    manager.createWorkstream({ name: 'billing', folder: demo, color: '#f2b84b' });
    const ws = manager.createWorkstream({ name: 'acme-api', folder: demo, color: '#7c8cf8' });
    manager.updateWorkstream({ id: ws.id, env: [{ name: 'ACME_ENV', value: 'staging' }, { name: 'MAPS_API_KEY', value: 'demo' }], uses: ['SENTRY_AUTH_TOKEN', 'STRIPE_SECRET_KEY'] });
    for (const role of ['tests', 'main']) {
      const s = await manager.newSession({ workstreamId: ws.id, role, model: 'haiku', effort: 'medium' });
      sids.push(s.id);
    }
    await waitFor(() => sids.every(id => manager.session(id).state === 'idle' && manager.pty.isLive(`s:${id}`)), 90000, 'sessions idle');
    const sh = manager.newShell({ workstreamId: ws.id });
    await sleep(2000);
    manager.setUi({ activeTab: `s:${sids[1]}` });
    await manager.refreshGit(demo, { pr: true });
    // The version and model display name arrive with the first statusLine.
    await waitFor(() => manager.session(sids[1]).header.version, 30000, 'statusLine header').catch(() => {});
    await sleep(3000);

    // Clipping: rows must fit inside the terminal area.
    report.fit = await wc.executeJavaScript(`(() => {
      const host = document.querySelector('[data-term="s:${sids[1]}"]');
      const screen = host.querySelector('.xterm-screen').getBoundingClientRect();
      const box = host.getBoundingClientRect();
      return { screenBottom: Math.round(screen.bottom), hostBottom: Math.round(box.bottom), fits: screen.bottom <= box.bottom + 0.5 };
    })()`);

    await shot('overview');
    await shot('header', `[data-session="${sids[1]}"]`);
    await wc.executeJavaScript(`document.querySelector('[data-act="wsSettings"]').click()`);
    await sleep(1000);
    await shot('settings', '#modal');
    await wc.executeJavaScript(`document.querySelector('[data-cancel]').click()`);
    await wc.executeJavaScript(`document.querySelector('#keysBtn').click()`);
    await sleep(1000);
    await shot('keys', '#modal');
    await wc.executeJavaScript(`document.querySelector('[data-cancel]').click()`);
    manager.setUi({ theme: 'light' });
    await sleep(1500);
    await shot('light');
    manager.setUi({ theme: 'system' });
    await wc.executeJavaScript(`document.querySelector('#helpBtn').click()`);
    await sleep(1500);
    report.helpImages = await wc.executeJavaScript(`[...document.querySelectorAll('.help-img')].map(i => i.naturalWidth > 0)`);
    await manager.closeShell(sh.id);
    report.ok = report.fit.fits && report.shots.every(x => !x.includes('not captured'));
  } catch (e) {
    report.ok = false;
    report.error = String(e.stack || e);
  }
  for (const id of sids) { try { await manager.deleteSession(id); } catch {} }
  fs.writeFileSync(path.join(OUT, 'help.json'), JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}

// Cowork bridge end to end: the real extension process (JSON-RPC over stdio) → pipe →
// polycli → a real Haiku session. Approvals are given through the Cowork core, as the
// buttons do. Also screenshots the Cowork bar for the help.
async function runBridge({ app, win, manager, cowork }) {
  const report = { phase: 'bridge', steps: [] };
  const step = (name, data = {}) => { report.steps.push({ name, ...data }); console.log('SMOKE', name, JSON.stringify(data).slice(0, 300)); };
  const wc = win.webContents;
  let sid = null, ext = null;
  try {
    const ws = manager.createWorkstream({ name: 'acme-api', folder: FOLDER });
    const s = await manager.newSession({ workstreamId: ws.id, role: 'main', model: 'haiku' });
    sid = s.id;
    await waitFor(() => manager.session(sid).state === 'idle' && manager.pty.isLive(`s:${sid}`), 90000, 'idle');
    await sleep(2000);

    const { spawn } = require('child_process');
    ext = spawn('node', [path.join(__dirname, '..', '..', '..', 'bridge', 'server', 'index.js')], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '', n = 0;
    const pending = new Map();
    ext.stdout.setEncoding('utf8');
    ext.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(m.id)?.(m); pending.delete(m.id); } });
    const rpc = (method, params) => new Promise(r => { const id = ++n; pending.set(id, r); ext.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    const tool = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); const t = r.result.content[0].text; try { return JSON.parse(t); } catch { return { error: t }; } };
    await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'smoke' } });

    let r = await tool('polycli_link', { task_title: 'Q4 launch plan', workstream: 'acme-api' });
    const link = r.link;
    step('link', { state: r.state });
    await sleep(1200);
    try { fs.writeFileSync(path.join(OUT, 'bridge-link.png'), (await wc.capturePage()).toPNG()); } catch {}
    cowork.decide({ kind: 'link', id: cowork.snapshot().pendingLinks[0].id, decision: 'approve', workstreamId: ws.id });
    r = await tool('polycli_link_status', { link, wait_seconds: 5 });
    step('link-status', r);

    const readUntilDone = async (turn) => {
      let v = await tool('polycli_read', { link, turn_id: turn, wait_seconds: 30 });
      const t0 = Date.now();
      while (!['done', 'failed', 'rejected'].includes(v.state) && Date.now() - t0 < 180000) v = await tool('polycli_read', { link, turn_id: turn, wait_seconds: 30 });
      return v;
    };

    // Short prompt, approved by the user.
    r = await tool('polycli_send', { link, session: 'main', text: 'Reply with exactly the word PONG and nothing else.', client_ref: 'smoke-1', wait_seconds: 1 });
    step('send-1', r);
    await sleep(1200);
    const HELP = path.join(__dirname, '..', '..', 'resources', 'help');
    try {
      const rect = await wc.executeJavaScript(`(() => { const r = document.querySelector('#coworkStrip').getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`);
      fs.writeFileSync(path.join(HELP, 'cowork-approval.png'), (await wc.capturePage(rect)).toPNG());
      report.shot = true;
    } catch (e) { report.shot = `not captured: ${e.message || e}`; }
    cowork.decide({ kind: 'turn', id: r.turn_id, decision: 'approve' });
    const v1 = await readUntilDone(r.turn_id);
    step('answer-1', v1);

    // Long multi-line prompt: Claude shows it as [Pasted text …] and treats it as quoted
    // content; the provenance line makes it act on it. Allowed by policy this time.
    manager.updateWorkstream({ id: ws.id, coworkSend: 'allow' });
    const notes = Array.from({ length: 20 }, (_, i) => `Note ${i + 1}: background detail that needs no action, lorem ipsum dolor sit amet.`).join('\n');
    r = await tool('polycli_send', { link, session: 'main', text: `Reply with exactly the word LONGPONG and nothing else.\n${notes}`, client_ref: 'smoke-2', wait_seconds: 30 });
    const v2 = ['done', 'failed'].includes(r.state) ? r : await readUntilDone(r.turn_id);
    step('answer-2', v2);
    r = await tool('polycli_add_artifact', { link, title: 'Launch plan', kind: 'document', url: 'https://claude.ai/artifact/demo', description: 'Draft v1' });
    step('artifact', r);
    report.ok = /PONG/.test(v1.response || '') && /LONGPONG/.test(v2.response || '') && !!r.artifact_id;
  } catch (e) {
    report.ok = false;
    report.error = String(e.stack || e);
  }
  try { ext?.stdin.end(); } catch {}
  if (sid) { try { await manager.deleteSession(sid); } catch {} }
  fs.writeFileSync(path.join(OUT, 'bridge.json'), JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}

async function run(ctx) {
  fs.mkdirSync(OUT, { recursive: true });
  if (process.env.POLYCLI_SMOKE === 'bridge') return runBridge(ctx);
  if (process.env.POLYCLI_SMOKE === 'help') return runHelp(ctx);
  if (process.env.POLYCLI_SMOKE === 'git') return runGit(ctx);
  if (process.env.POLYCLI_SMOKE === 'ui') return runUi(ctx);
  if (process.env.POLYCLI_SMOKE === 'clip') return runClip(ctx);
  if (process.env.POLYCLI_SMOKE === 'needs') return runNeeds(ctx);
  if (process.env.POLYCLI_SMOKE === 'launch') return runLaunch(ctx);
  if (process.env.POLYCLI_SMOKE === 'verify') return runVerify(ctx);
  return runFlow(ctx);
}

async function runFlow({ app, win, manager }) {
  const report = { startedAt: new Date().toISOString(), steps: [] };
  const step = (name, data = {}) => { report.steps.push({ name, at: new Date().toISOString(), ...data }); console.log('SMOKE', name, JSON.stringify(data)); };
  const shot = async name => {
    await sleep(600);
    // Capturing can fail while the window is covered or minimized; screenshots are
    // only a record, so that doesn't fail the run.
    try { fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG()); }
    catch (e) { step('screenshot-skipped', { name, error: String(e.message || e) }); }
  };
  const S = id => manager.session(id);
  let sid = null;
  try {
    const ws = manager.createWorkstream({ name: 'smoke-test', folder: FOLDER });
    step('workstream', { id: ws.id });

    const t0 = Date.now();
    const s = await manager.newSession({ workstreamId: ws.id, role: 'pong', model: 'haiku' });
    sid = s.id;
    step('launched', { bgId: s.bgId, state: s.state, ms: Date.now() - t0, error: s.error });
    await waitFor(() => manager.pty.isLive(`s:${sid}`), 10000, 'attach pty');
    await waitFor(() => S(sid).header.version && S(sid).state === 'idle', 60000, 'statusLine header + idle');
    step('attached', { header: S(sid).header, state: S(sid).state, ms: Date.now() - t0 });

    // A prompt typed through the pane, the way the bridge will deliver it.
    step('submitted', { registered: await manager.submitPrompt(sid, 'Reply with exactly the word PONG and nothing else.') });
    await waitFor(() => S(sid).state === 'busy' || S(sid).lastMessage, 20000, 'busy');
    await waitFor(() => S(sid).state === 'idle' && S(sid).lastMessage, 90000, 'Stop');
    step('prompt', { lastPrompt: S(sid).lastPrompt, lastMessage: S(sid).lastMessage, header: S(sid).header });
    await shot('smoke-1-session');

    await manager.closeSession(sid);
    const afterClose = (await claude.agents() || []).find(a => a.id === S(sid).bgId);
    step('closed', { state: S(sid).state, termLive: manager.pty.isLive(`s:${sid}`), agentState: afterClose && afterClose.state });
    await shot('smoke-2-closed');

    await manager.reopenSession(sid);
    await waitFor(() => manager.pty.isLive(`s:${sid}`) && S(sid).state === 'idle', 60000, 'reopen idle');
    step('reopened', { state: S(sid).state });

    await manager.restartSession(sid);
    await waitFor(() => manager.pty.isLive(`s:${sid}`) && S(sid).state === 'idle', 60000, 'restart idle');
    step('restarted', { state: S(sid).state });
    step('submitted-after-restart', { registered: await manager.submitPrompt(sid, 'Reply with exactly the word PONG2 and nothing else.') });
    await waitFor(() => S(sid).lastMessage && S(sid).lastMessage.includes('PONG2') && S(sid).state === 'idle', 90000, 'Stop after restart');
    step('prompt-after-restart', { lastMessage: S(sid).lastMessage });

    const h = manager.newShell({ workstreamId: ws.id });
    await sleep(2500);
    manager.write(`h:${h.id}`, 'echo polycli-shell-ok\r');
    await waitFor(() => manager.pty.scrollback(`h:${h.id}`).includes('polycli-shell-ok\r\n') || manager.pty.scrollback(`h:${h.id}`).split('polycli-shell-ok').length > 2, 15000, 'shell echo');
    step('shell', { ok: true });
    await shot('smoke-3-shell');
    step('vscode', { codeExe: vscode.codeExe() });

    await manager.closeShell(h.id);
    await manager.deleteSession(sid);
    const afterDelete = (await claude.agents() || []).find(a => a.id === s.bgId);
    step('deleted', { stillListed: !!afterDelete });
    sid = null;
    report.ok = true;
  } catch (e) {
    report.ok = false;
    report.error = String(e.stack || e);
    try { await shot('smoke-error'); } catch {}
    if (sid) report.session = manager.snapshot().sessions.find(x => x.id === sid);
    if (sid) report.scrollbackTail = manager.pty.scrollback(`s:${sid}`).slice(-3000);
  } finally {
    if (sid) { try { await manager.deleteSession(sid); } catch {} }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, 'smoke.json'), JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  }
}

module.exports = { run };
