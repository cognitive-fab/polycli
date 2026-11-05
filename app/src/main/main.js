'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, Notification, Menu, clipboard, shell } = require('electron');
const { paths, ensureDirs } = require('./paths');
const { installHelpers, HookServer } = require('./hooks');
const { PtyClient } = require('./ptyclient');
const { Manager } = require('./sessions');
const vscode = require('./vscode');
const store = require('./store');

app.setAppUserModelId('polycli');
if (process.env.POLYCLI_HOME) app.setPath('userData', path.join(process.env.POLYCLI_HOME, 'electron'));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null;
let manager = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 800, minHeight: 500,
    backgroundColor: '#14161c', title: 'polycli', autoHideMenuBar: true,
    show: !process.env.POLYCLI_SMOKE_HIDDEN,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function pushState() {
  const snap = manager.snapshot();
  send('state', snap);
  const ws = snap.workstreams.find(w => w.id === snap.ui.activeWorkstream);
  const waiting = snap.sessions.filter(s => s.state === 'needs-you').length;
  if (win && !win.isDestroyed()) win.setTitle(`${waiting ? `(${waiting}) ` : ''}${ws ? ws.name + ' — ' : ''}polycli`);
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
  state: () => manager.snapshot(),
  createWorkstream: a => manager.createWorkstream(a),
  renameWorkstream: a => manager.renameWorkstream(a),
  updateWorkstream: a => manager.updateWorkstream(a),
  globalKeys: () => require('./env').globalKeys(),
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
  newShell: a => manager.newShell(a).id,
  restartShell: a => manager.restartShell(a.id),
  closeShell: a => manager.closeShell(a.id),
  scrollback: a => manager.pty.scrollback(String(a.term)),
  openVSCode: async a => { await vscode.open(vscodeTarget(a), { mode: a.mode === 'new' ? 'new' : 'reuse', root: !!a.root }); },
  copyText: a => clipboard.writeText(String(a.text ?? '').slice(0, 1 << 20)),
  pickFolder: async a => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: a && a.defaultPath });
    return r.canceled ? null : r.filePaths[0];
  },
};

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
  ensureDirs();
  installHelpers();

  const pty = new PtyClient();
  manager = new Manager(pty);
  pty.on('data', (term, data) => send('pty:data', term, data));
  manager.on('changed', pushState);
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
  win.webContents.once('did-finish-load', () => {
    manager.restore();
    manager.startPolling();
    pushState();
    if (process.env.POLYCLI_SMOKE) require('./smoke').run({ app, win, manager }).catch(e => { console.error(e); app.exit(1); });
  });

  win.on('focus', () => win.flashFrame(false));
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('before-quit', () => { manager.dispose(); hooks.stop(); pty.dispose(); store.flush(); });
});

app.on('window-all-closed', () => app.quit());
