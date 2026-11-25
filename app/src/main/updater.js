'use strict';
// Updates for an installed polycli (docs/design/v0.4.md §10), from GitHub Releases of
// cognitive-fab/polycli through electron-updater: checked at start and every six hours,
// downloaded in the background, and installed when the user says so or when polycli
// quits. A run from source never updates itself.
const { EventEmitter } = require('events');

const EVERY_MS = 6 * 3600e3;

class Updater extends EventEmitter {
  constructor(app, { enabled = () => true } = {}) {
    super();
    this.app = app;
    this.enabled = enabled;
    this.status = { state: app.isPackaged ? 'idle' : 'source', version: app.getVersion(), next: null, notes: null, error: null, checkedAt: null };
    if (!app.isPackaged) return;
    const { autoUpdater } = require('electron-updater');
    this.au = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;    // "Update when I quit"
    autoUpdater.allowPrerelease = false;
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => this.set({ state: 'idle', checkedAt: Date.now() }));
    autoUpdater.on('update-available', i => this.set({ state: 'downloading', next: i.version, notes: notesOf(i) }));
    autoUpdater.on('download-progress', p => this.set({ state: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', i => this.set({ state: 'ready', next: i.version, notes: notesOf(i), checkedAt: Date.now() }));
    autoUpdater.on('error', e => this.set({ state: 'error', error: String(e?.message || e).split('\n')[0].slice(0, 300) }));
    setTimeout(() => this.check(false), 15000).unref?.();
    this.timer = setInterval(() => this.check(false), EVERY_MS);
    this.timer.unref?.();
  }
  set(patch) { Object.assign(this.status, patch); this.emit('changed', this.status); }
  async check(byUser = true) {
    if (!this.au) return this.status;
    if (!byUser && !this.enabled()) return this.status;
    try { await this.au.checkForUpdates(); } catch (e) { this.set({ state: 'error', error: String(e?.message || e).split('\n')[0] }); }
    return this.status;
  }
  // Restart now: polycli quits (Claude sessions keep running in the background; shells
  // end and pinned ones start again), the installer runs silently, polycli starts again.
  installNow() {
    if (!this.au || this.status.state !== 'ready') throw new Error('No update is ready');
    setImmediate(() => this.au.quitAndInstall(true, true));
  }
  dispose() { clearInterval(this.timer); }
}

// Release notes as plain text (GitHub gives HTML).
function notesOf(i) {
  const n = Array.isArray(i.releaseNotes) ? i.releaseNotes.map(x => x.note).join('\n') : i.releaseNotes;
  return n ? String(n).replace(/<\/(p|li|h\d)>/g, '\n').replace(/<li>/g, '• ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000) : null;
}

module.exports = { Updater };
