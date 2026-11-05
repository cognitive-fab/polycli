'use strict';
// The renderer's whole view of the main process. Every call is validated again in main.
const { contextBridge, ipcRenderer } = require('electron');

const call = (op, args) => ipcRenderer.invoke('polycli', op, args);

contextBridge.exposeInMainWorld('polycli', {
  call,
  write: (term, data) => ipcRenderer.send('pty:write', term, data),
  resize: (term, cols, rows) => ipcRenderer.send('pty:resize', term, cols, rows),
  onState: fn => ipcRenderer.on('state', (_e, s) => fn(s)),
  onData: fn => ipcRenderer.on('pty:data', (_e, term, data) => fn(term, data)),
  onFocusTab: fn => ipcRenderer.on('focus-tab', (_e, tab) => fn(tab)),
});
