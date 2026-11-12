'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, Notification, Menu, clipboard, shell, protocol, powerMonitor } = require('electron');
const { paths, ensureDirs } = require('./paths');
const { installHelpers, HookServer } = require('./hooks');
const { PtyClient } = require('./ptyclient');
const { Manager } = require('./sessions');
const { Cowork } = require('./cowork');
const { BridgeServer, bridgePipeName } = require('./bridge');
const vscode = require('./vscode');
const files = require('./projectfiles');
const { Billing } = require('./billing');
const { Board } = require('./board');
const { Tests } = require('./tests');
const store = require('./store');

// Diagrams and images from a workstream's architecture/ and docs/ folders (projectfiles.js).
protocol.registerSchemesAsPrivileged([{ scheme: 'polycli-view', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

app.setAppUserModelId('polycli');
if (process.env.POLYCLI_HOME) app.setPath('userData', path.join(process.env.POLYCLI_HOME, 'electron'));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null;
let manager = null;
let cowork = null;
let billing = null;
let board = null;
let tests = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 800, minHeight: 500,
    backgroundColor: '#14161c', title: 'polycli', autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'resources', 'icon', 'polycli.ico'),
    show: !process.env.POLYCLI_SMOKE_HIDDEN,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // A link in a diagram (a source line on GitHub) opens in the browser; nothing opens in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const u = require('./git').safeGithubUrl(url);
    if (u) shell.openExternal(u);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', e => e.preventDefault());
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function snapshot() {
  const snap = manager.snapshot();
  if (billing) snap.workstreams = snap.workstreams.map(w => ({ ...w, billable: billing.isBillable(w.id) }));
  return { ...snap, cowork: cowork ? cowork.snapshot() : null, billing: billing ? billing.summary() : null, noRemoteGlobal: require('./sessions').globalNoRemote() };
}

function pushState() {
  const snap = snapshot();
  send('state', snap);
  const ws = snap.workstreams.find(w => w.id === snap.ui.activeWorkstream);
  const waiting = snap.sessions.filter(s => s.state === 'needs-you').length + (snap.cowork ? snap.cowork.approvals.length + snap.cowork.pendingLinks.length : 0);
  if (win && !win.isDestroyed()) win.setTitle(`${waiting ? `(${waiting}) ` : ''}${ws ? ws.name + ' — ' : ''}polycli`);
}

// An image pasted with no file behind it (a screenshot, an image copied from a page):
// save it under %APPDATA%\polycli\pastes so its path can be typed into the pane, where
// Claude attaches it. The bytes come from the paste event; only the image formats
// Claude reads are kept. Pastes older than 7 days are removed at startup.
const PASTE_KEEP_MS = 7 * 24 * 3600 * 1000;
const PASTE_MAX = 32 << 20;
function imageExt(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
function savePastedImage({ data } = {}) {
  if (!(data instanceof Uint8Array) || !data.length || data.length > PASTE_MAX) throw new Error('The pasted image is empty or larger than 32 MB');
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const ext = imageExt(b);
  if (!ext) throw new Error('Only PNG, JPEG, GIF and WebP images can be pasted');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(paths.pastes, `paste-${stamp}-${require('crypto').randomBytes(2).toString('hex')}.${ext}`);
  require('fs').writeFileSync(file, b);
  return file;
}
function prunePastes() {
  const fs = require('fs');
  try {
    for (const f of fs.readdirSync(paths.pastes)) {
      if (!/^paste-[\w-]+\.(png|jpg|gif|webp)$/.test(f)) continue;
      const p = path.join(paths.pastes, f);
      if (Date.now() - fs.statSync(p).mtimeMs > PASTE_KEEP_MS) fs.rmSync(p, { force: true });
    }
  } catch {}
}

// Resolve what to open in VS Code from polycli's own records, never from a raw path.
function vscodeTarget({ sessionId, workstreamId, shellId, doc }) {
  if (sessionId) {
    const s = manager.session(sessionId);
    if (doc !== undefined) {
      const d = s.documents[doc];
      if (!d) throw new Error('unknown document');
      return d.path;
    }
    return s.liveCwd || s.cwd;   // follows the session into a worktree
  }
  if (shellId) return manager.shell(shellId).cwd;
  if (workstreamId) return manager.ws(workstreamId).folder;
  throw new Error('nothing to open');
}

const OPS = {
  state: () => snapshot(),
  coworkDecide: a => cowork.decide({ kind: a.kind, id: a.id, decision: a.decision === 'approve' ? 'approve' : 'reject', workstreamId: a.workstreamId, text: a.text }),
  coworkRejectAllLinks: () => cowork.rejectAllLinks(),
  coworkMute: a => cowork.mute(a.minutes),
  coworkAuto: a => cowork.setAuto(!!a.on),
  coworkRevoke: a => cowork.revoke(a.id),
  installBridge: () => require('./bridge').installExtension(),
  // Artifacts come from Cowork: links open only if https, files are only revealed in
  // Explorer (never opened, which could run them).
  openArtifact: a => {
    const art = cowork.c.artifacts.find(x => x.id === a.id);
    if (!art) throw new Error('unknown artifact');
    if (a.what === 'url' && art.url && /^https:\/\//i.test(art.url)) return shell.openExternal(art.url);
    if (a.what === 'path' && art.path) {
      if (!require('fs').existsSync(art.path)) throw new Error('The file is no longer there');
      return shell.showItemInFolder(art.path);
    }
    throw new Error('nothing to open');
  },
  createWorkstream: a => manager.createWorkstream(a),
  renameWorkstream: a => manager.renameWorkstream(a),
  updateWorkstream: a => manager.updateWorkstream(a),
  archiveWorkstream: a => manager.archiveWorkstream({ id: a.id }),
  restoreWorkstream: a => manager.restoreWorkstream({ id: a.id }),
  globalKeys: () => require('./env').globalKeys(),
  helpText: () => require('fs').readFileSync(path.join(__dirname, '..', '..', 'resources', 'help', 'HELP.md'), 'utf8'),
  boardLoad: a => board.load(a.workstreamId),
  boardOp: a => board.op(a.workstreamId, a),
  boardChat: a => board.chat(a.workstreamId, a.id),
  boardDocs: a => board.docs(a.workstreamId, a.id),
  boardSend: a => board.send(a.workstreamId, a.id, a.text),
  boardStop: a => board.stop(a.workstreamId, a.id),
  testsInfo: a => tests.info(a.workstreamId),
  testsRun: a => tests.run(a.workstreamId, String(a.script)),
  testsStop: a => tests.stop(a.workstreamId),
  setBillable: a => billing.setBillable(manager.ws(a.workstreamId), !!a.on),
  billingHistory: () => billing.history(),
  archList: a => files.listArchitecture(manager.ws(a.workstreamId).folder),
  docList: a => files.listDir(manager.ws(a.workstreamId).folder, a.rel),
  docRead: a => files.readFile(manager.ws(a.workstreamId).folder, a.rel),
  docWrite: a => files.writeFile(manager.ws(a.workstreamId).folder, a.rel, a.text, a.mtime, !!a.force),
  docCreate: a => files.createDoc(manager.ws(a.workstreamId).folder, a.rel, a.name),
  openLink: a => { if (!/^https:\/\//i.test(String(a.url))) throw new Error('Only https links can be opened'); return shell.openExternal(String(a.url)); },
  gitFiles: a => manager.gitFiles(a.id),
  commitSession: a => manager.commitSession({ id: a.id, message: a.message, all: a.all }),
  pushSession: a => manager.pushSession({ id: a.id }),
  deploySession: a => manager.deploySession({ id: a.id }),
  refreshGit: a => manager.refreshGit((s => s.liveCwd || s.cwd)(manager.session(a.id)), { pr: true }),
  askClaudeCommit: a => manager.submitPrompt(a.id, 'Commit the current changes in this repository with a clear, conventional commit message. Do not push.'),
  openGithub: a => { const u = require('./git').safeGithubUrl(a.url); if (!u) throw new Error('Only github.com links can be opened'); return shell.openExternal(u); },
  setActive: a => manager.setActive(a.id),
  setUi: a => manager.setUi(a),
  newSession: a => manager.newSession(a).then(s => s.id),
  closeSession: a => manager.closeSession(a.id),
  reopenSession: a => manager.reopenSession(a.id),
  restartSession: a => manager.restartSession(a.id),
  deleteSession: a => manager.deleteSession(a.id),
  newShell: a => manager.newShell({ workstreamId: a.workstreamId, cwd: a.cwd, name: a.name, agent: a.agent, kind: a.kind, distro: a.distro, host: a.host, dir: a.dir, key: a.key, port: a.port, user: a.user }).id,
  shellKinds: async () => {
    const k = require('./shellkinds');
    return { wsl: await k.wslDistros(), ssh: k.sshHosts(), keys: k.sshKeys() };
  },
  restartShell: a => manager.restartShell(a.id),
  closeShell: a => manager.closeShell(a.id),
  pinShell: a => manager.pinShell({ id: a.id, command: a.command, after: a.after || null, when: a.when, text: a.text, port: a.port, run: !!a.run }),
  runShell: a => manager.runShell(a.id),
  scrollback: a => manager.pty.scrollback(String(a.term)),
  prompts: a => manager.prompts(a.id),
  loginItem: () => loginItem(),
  setLoginItem: a => loginItem(!!a.on),
  openVSCode: async a => { await vscode.open(vscodeTarget(a), { mode: a.mode === 'new' ? 'new' : 'reuse', root: !!a.root }); },
  copyText: a => clipboard.writeText(String(a.text ?? '').slice(0, 1 << 20)),
  savePastedImage: a => savePastedImage(a),
  pickFolder: async a => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: a && a.defaultPath });
    return r.canceled ? null : r.filePaths[0];
  },
};

// Start polycli when the user signs in to Windows (HKCU Run entry, named after the
// AppUserModelId). From source, that runs Electron with the app folder, as npm start
// does but without a console window.
function loginItem(on) {
  const opts = { path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] };
  if (on !== undefined) app.setLoginItemSettings({ ...opts, openAtLogin: on });
  return { on: app.getLoginItemSettings(opts).openAtLogin, packaged: app.isPackaged };
}

// polycli needs claude, and node for the hook helpers (hooks.js): without node a
// session runs but never reports that it is busy, done or waiting on you. An installed
// polycli can't assume either, so it says once at startup what is missing.
const REQUIREMENTS = [
  { exe: 'claude', title: 'Claude Code was not found', detail: 'polycli runs Claude Code sessions with the claude command, which is not on PATH. Install Claude Code (https://claude.com/claude-code), then start polycli again.', url: 'https://claude.com/claude-code' },
  { exe: 'node', minMajor: 18, title: 'Node.js was not found', detail: 'polycli learns what a session is doing (working, done, waiting on you) from small helpers that run with node, which is not on PATH. Without it, sessions run but their state and the ✋ marker are not shown. Install Node.js 18 or newer (winget install OpenJS.NodeJS.LTS, or https://nodejs.org), then start polycli again.', url: 'https://nodejs.org' },
];
function onPath(exe) {
  return new Promise(resolve => require('child_process').execFile('where.exe', [exe], { windowsHide: true, timeout: 10000, env: require('./env').cleanEnv() }, err => resolve(!err)));
}
// Major version of a tool that prints "v20.11.0" for --version (node), or null.
function majorVersion(exe) {
  return new Promise(resolve => require('child_process').execFile(exe, ['--version'], { windowsHide: true, timeout: 10000, env: require('./env').cleanEnv() }, (err, out) => {
    const m = !err && /^v?(\d+)\./.exec(String(out).trim());
    resolve(m ? Number(m[1]) : null);
  }));
}
async function checkRequirements() {
  for (const r of REQUIREMENTS) {
    let { title, detail } = r;
    if (await onPath(r.exe)) {
      if (!r.minMajor) continue;
      const major = await majorVersion(r.exe);
      if (major !== null && major >= r.minMajor) continue;
      // A node that doesn't answer `node --version` won't run the helpers either.
      title = major === null ? 'Node.js does not run' : `Node.js ${major} is too old`;
      detail = detail.replace('which is not on PATH', major === null ? `but "node --version" failed; they need a working Node.js ${r.minMajor} or newer` : `and they need Node.js ${r.minMajor} or newer`);
    }
    const { response } = await dialog.showMessageBox(win, { type: 'warning', title: 'polycli', message: title, detail, buttons: ['Open the download page', 'OK'], defaultId: 1, cancelId: 1, noLink: true });
    if (response === 0) shell.openExternal(r.url);
  }
}

function wireIpc() {
  ipcMain.handle('polycli', async (_e, op, args) => {
    const fn = OPS[op];
    if (!fn) throw new Error(`unknown operation ${op}`);
    const result = await fn(args && typeof args === 'object' ? args : {});
    return result === undefined ? null : JSON.parse(JSON.stringify(result));
  });
  ipcMain.on('pty:write', (_e, term, data) => manager.write(String(term), data));
  ipcMain.on('pty:resize', (_e, term, cols, rows) => manager.resize(String(term), cols, rows));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  files.installViewProtocol(protocol, id => manager.state.workstreams.find(w => w.id === id)?.folder);
  ensureDirs();
  prunePastes();
  installHelpers();

  const pty = new PtyClient();
  manager = new Manager(pty);
  pty.on('data', (term, data) => send('pty:data', term, data));
  manager.on('changed', pushState);
  cowork = new Cowork(manager);
  board = new Board(manager);
  board.on('event', ev => send('board:event', ev));
  tests = new Tests(manager);
  tests.on('event', ev => send('tests:event', ev));
  billing = new Billing(manager, {
    isActive: () => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused(),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
  });
  cowork.on('attention', () => { if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true); });
  // Auto mode links a task without asking: say so in the window (a toast), once.
  cowork.on('auto', e => send('cowork-auto', e));
  const bridge = new BridgeServer(cowork);
  bridge.on('error', e => console.error(`bridge pipe (${bridgePipeName()}) failed`, e.message));
  bridge.start();
  manager.on('attention', s => {
    // Windows only delivers toasts for an app registered with a Start menu shortcut
    // (the installer creates it). A dev run gets "Settings prevent the notification
    // type from being delivered", so the taskbar button flashes as well.
    if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: `${s.name} needs you`, body: s.attention?.message || '' });
    global.polycliLastToast = { session: s.id, result: 'pending' };
    n.on('show', () => { global.polycliLastToast.result = 'shown'; });
    n.on('failed', (_e, err) => { global.polycliLastToast.result = `failed: ${err}`; });
    n.on('click', () => { if (win) { win.show(); win.focus(); } send('focus-tab', `s:${s.id}`); });
    n.show();
  });

  const hooks = new HookServer();
  hooks.on('event', m => manager.onHook(m));
  hooks.on('error', e => {
    console.error('hook pipe failed', e);
    dialog.showErrorBox('polycli', `Could not listen on the hook pipe (${paths.pipeName}). Is another polycli running?\n\n${e.message}`);
  });
  hooks.start();

  wireIpc();
  createWindow();
  billing.start();
  win.webContents.once('did-finish-load', () => {
    manager.restore();
    manager.startPolling();
    pushState();
    if (process.env.POLYCLI_SMOKE) require('./smoke').run({ app, win, manager, cowork }).catch(e => { console.error(e); app.exit(1); });
    else checkRequirements().catch(() => {});
  });

  win.on('focus', () => win.flashFrame(false));
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('before-quit', () => { board.dispose(); tests.dispose(); billing.stop(); cowork.dispose(); bridge.stop(); manager.dispose(); hooks.stop(); pty.dispose(); store.flush(); });
});

app.on('window-all-closed', () => app.quit());
