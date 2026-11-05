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
    report.ok = report.settingsRows === 3 && /ANTHROPIC_API_KEY/.test(report.warning) && report.keyRows > 0;
  } catch (e) {
    report.ok = false;
    report.error = String(e.stack || e);
  }
  fs.writeFileSync(path.join(OUT, 'ui.json'), JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}

async function run(ctx) {
  fs.mkdirSync(OUT, { recursive: true });
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
