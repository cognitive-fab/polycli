'use strict';
// Export and import of polycli's settings (docs/design/v0.4.md §10), to set up a second
// PC: workstreams (name, color, folder, deploy, billable, Cowork policy, Claude
// configuration, the NAMES of their variables), pinned shells, permission profiles and
// app settings. Variable values never leave the PC: they are encrypted for this Windows
// account, and import asks for them again.
const fs = require('fs');
const FORMAT = 'polycli-settings';
const VERSION = 1;

function exportSettings(manager, { isBillable = () => false } = {}) {
  const st = manager.state;
  const wsName = id => st.workstreams.find(w => w.id === id)?.name;
  return {
    format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(),
    workstreams: st.workstreams.filter(w => !w.archived).map(w => ({
      name: w.name, color: w.color, folder: w.folder, deploy: w.deploy || null, billable: isBillable(w.id), coworkSend: w.coworkSend || 'ask',
      envNames: (w.env || []).map(e => e.name), uses: w.uses || [],
      plugins: w.plugins || {}, skills: w.skills || {}, mcpOff: w.mcpOff || [], profile: w.profile || 'standard', perm: w.perm || null,
    })),
    pinnedShells: st.shells.filter(h => h.pin?.command && wsName(h.workstreamId)).map(h => ({
      workstream: wsName(h.workstreamId), name: h.name, cwd: h.cwd, kind: h.kind || 'pwsh', distro: h.distro, host: h.host, dir: h.dir, key: h.key, port: h.port, user: h.user,
      pin: { command: h.pin.command, after: h.pin.after ? st.shells.find(x => x.id === h.pin.after)?.name || null : null, when: h.pin.when, text: h.pin.text, port: h.pin.port },
    })),
    profiles: st.profiles,
    app: { hotkey: st.ui.hotkey ?? null, remoteDefault: st.ui.remoteDefault !== false, theme: st.ui.theme || 'system', updates: st.ui.updates !== false },
  };
}

function readExport(file) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('This file is not a polycli settings export'); }
  if (j?.format !== FORMAT || typeof j.version !== 'number') throw new Error('This file is not a polycli settings export');
  if (j.version > VERSION) throw new Error('This export comes from a newer polycli; update polycli first');
  if (!Array.isArray(j.workstreams)) throw new Error('The export has no workstreams');
  return j;
}

// What an import would do, for the dialog: each workstream added or updated, whether its
// folder exists here, and which variables need a value.
function preview(manager, j) {
  return {
    exportedAt: j.exportedAt,
    workstreams: j.workstreams.slice(0, 200).map((w, i) => {
      const existing = manager.state.workstreams.find(x => x.name.toLowerCase() === String(w.name || '').toLowerCase());
      const have = new Set((existing?.env || []).map(e => e.name.toUpperCase()));
      return { index: i, name: String(w.name || ''), folder: String(w.folder || ''), folderExists: !!w.folder && fs.existsSync(w.folder), action: existing ? 'update' : 'add', envNeeded: (w.envNames || []).filter(n => !have.has(String(n).toUpperCase())) };
    }),
    pinnedShells: (j.pinnedShells || []).length,
    profiles: (j.profiles || []).map(p => p.name),
  };
}

// choices: { [index]: { skip, folder, env: { NAME: value } } }. Returns a summary.
// Every field goes through the app's own checks (createWorkstream, updateWorkstream…).
async function applyImport(manager, j, choices = {}, { setBillable = () => {} } = {}) {
  const done = { added: [], updated: [], skipped: [], shells: 0, profiles: 0, errors: [] };
  if (Array.isArray(j.profiles) && j.profiles.length) {
    const byId = new Map(manager.state.profiles.map(p => [p.id, p]));
    for (const p of j.profiles) if (p && p.id) byId.set(p.id, p);
    try { manager.setProfiles([...byId.values()]); done.profiles = j.profiles.length; } catch (e) { done.errors.push(`Profiles: ${e.message}`); }
  }
  const idByName = new Map();
  const moved = new Map();   // workstream id → its folder in the export and here
  for (const [i, w] of j.workstreams.entries()) {
    const c = choices[i] || {};
    if (c.skip) { done.skipped.push(w.name); continue; }
    try {
      let target = manager.state.workstreams.find(x => x.name.toLowerCase() === String(w.name || '').toLowerCase());
      if (!target) {
        target = manager.createWorkstream({ name: w.name, folder: c.folder || w.folder, color: w.color });
        done.added.push(target.name);
      } else done.updated.push(target.name);
      const env = Object.entries(c.env || {}).filter(([, v]) => typeof v === 'string' && v).map(([name, value]) => ({ name, value }));
      const keep = (target.env || []).map(e => ({ name: e.name }));
      manager.updateWorkstream({
        id: target.id, color: w.color, deploy: w.deploy ?? undefined, coworkSend: w.coworkSend, uses: w.uses,
        env: env.length ? [...keep.filter(k => !env.some(e => e.name.toUpperCase() === k.name.toUpperCase())), ...env] : undefined,
        plugins: w.plugins || {}, skills: w.skills || {}, mcpOff: w.mcpOff || [],
        profile: manager.state.profiles.some(p => p.id === w.profile) ? w.profile : 'standard', perm: w.perm || {},
      });
      if (typeof w.billable === 'boolean') setBillable(target, w.billable);
      idByName.set(String(w.name).toLowerCase(), target.id);
      moved.set(target.id, { from: String(w.folder || ''), to: target.folder });
    } catch (e) { done.errors.push(`${w.name}: ${e.message}`); }
  }
  // Pinned shells: created, pinned, and started by their own rules; a dependency is found by name.
  const created = new Map();
  for (const p of (j.pinnedShells || []).slice(0, 100)) {
    const wsId = idByName.get(String(p.workstream || '').toLowerCase());
    if (!wsId) continue;
    try {
      // A shell in the workstream's folder (or below) follows the folder to where it is here.
      const m = moved.get(wsId);
      let cwd = p.cwd;
      if (m && cwd && m.from && (cwd.toLowerCase() === m.from.toLowerCase() || cwd.toLowerCase().startsWith(m.from.toLowerCase() + '\\'))) cwd = m.to + cwd.slice(m.from.length);
      const h = manager.newShell({ workstreamId: wsId, cwd, name: p.name, kind: p.kind, distro: p.distro, host: p.host, dir: p.dir, key: p.key, port: p.port, user: p.user });
      created.set(`${wsId}:${p.name}`, { h, p });
      done.shells++;
    } catch (e) { done.errors.push(`Shell ${p.name}: ${e.message}`); }
  }
  for (const [k, { h, p }] of created) {
    const wsId = k.split(':')[0];
    const after = p.pin.after ? created.get(`${wsId}:${p.pin.after}`)?.h.id || null : null;
    try { await manager.pinShell({ id: h.id, command: p.pin.command, after, when: p.pin.when, text: p.pin.text, port: p.pin.port, run: false }); } catch (e) { done.errors.push(`Pin ${p.name}: ${e.message}`); }
  }
  return done;
}

module.exports = { exportSettings, readExport, preview, applyImport, FORMAT };
