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
    manager.write(`s:${sid}`, '');   // Esc: decline the permission prompt
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

async function run(ctx) {
  fs.mkdirSync(OUT, { recursive: true });
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
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
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
