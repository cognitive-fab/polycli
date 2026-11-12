'use strict';
// The renderer's whole view of the main process. Every call is validated again in main.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (op, args) => ipcRenderer.invoke('polycli', op, args);

contextBridge.exposeInMainWorld('polycli', {
  call,
  write: (term, data) => ipcRenderer.send('pty:write', term, data),
  resize: (term, cols, rows) => ipcRenderer.send('pty:resize', term, cols, rows),
  onState: fn => ipcRenderer.on('state', (_e, s) => fn(s)),
  onData: fn => ipcRenderer.on('pty:data', (_e, term, data) => fn(term, data)),
  onBoard: fn => ipcRenderer.on('board:event', (_e, ev) => fn(ev)),
  onTests: fn => ipcRenderer.on('tests:event', (_e, ev) => fn(ev)),
  onCoworkAuto: fn => ipcRenderer.on('cowork-auto', (_e, ev) => fn(ev)),
  onFocusTab: fn => ipcRenderer.on('focus-tab', (_e, tab) => fn(tab)),
  // The path of a file pasted or dropped from Explorer ('' for data without a file).
  filePath: file => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
});
