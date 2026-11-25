// When a workstream's sessions need a Restart (cfgRev): only when what their settings
// file would get changes, not on every save of the dialog or the profiles editor.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.POLYCLI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'polycli-restart-'));
require('../paths').ensureDirs();
const { Manager } = require('../sessions');
const pty = { isLive: () => false, on() {}, off() {}, spawn() {}, write() {}, resize() {}, scrollback: () => '', pos: () => 0, since: () => '', kill() {}, dispose() {} };

function setup() {
  const m = new Manager(pty);
  m.state.workstreams = [{ id: 'w1', name: 'alpha', folder: os.tmpdir() }];
  return { m, w: m.state.workstreams[0] };
}
// What the settings dialog sends when nothing was changed in its Claude tabs.
const dialogSave = (m, extra = {}) => m.updateWorkstream({ id: 'w1', name: 'alpha', plugins: {}, skills: {}, mcpOff: [], profile: 'standard', perm: { mode: '', deny: [], ask: [], allow: [], dirs: [] }, ...extra });

test('saving the dialog without a change, or only renaming, needs no Restart', () => {
  const { m, w } = setup();
  dialogSave(m);
  assert.equal(w.cfgRev || 0, 0);
  dialogSave(m, { name: 'beta' });
  assert.equal(w.cfgRev || 0, 0);
  m.dispose();
});

test('a real change needs a Restart, once', () => {
  const { m, w } = setup();
  dialogSave(m, { mcpOff: ['agentmesh'] });
  assert.equal(w.cfgRev, 1);
  dialogSave(m, { mcpOff: ['agentmesh'] });
  assert.equal(w.cfgRev, 1);
  m.dispose();
});

test('saving the profiles unchanged needs no Restart; changing the one in use does', () => {
  const { m, w } = setup();
  dialogSave(m, { profile: 'careful' });
  const rev = w.cfgRev;
  m.setProfiles(structuredClone(m.state.profiles));
  assert.equal(w.cfgRev, rev);
  m.setProfiles(m.state.profiles.map(p => (p.id === 'live-systems' ? { ...p, ask: [...p.ask, 'Bash(terraform *)'] } : p)));
  assert.equal(w.cfgRev, rev, 'a profile it does not use');
  m.setProfiles(m.state.profiles.map(p => (p.id === 'careful' ? { ...p, deny: [...p.deny, 'Bash(git reset --hard *)'] } : p)));
  assert.equal(w.cfgRev, rev + 1);
  m.dispose();
});
