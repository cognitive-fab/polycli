// Workstream settings, in four tabs (docs/design/v0.4.md):
//   General — name, color, Cowork prompts, deploy command, billable, archive
//   Environment — the workstream's variables and the global keys it uses
//   Plugins and skills — which plugins and skills its Claude sessions get (§1)
//   MCP and permissions — MCP servers, permission profile and rules, rule cleanup (§2)
// One form: every tab's fields are saved together. And the permission profiles
// editor, opened from polycli ⚙.

const BILLING_VARS = /^(ANTHROPIC_|CLAUDE_CODE_USE_)/i;
const SKILL_LEVELS = [['', 'On'], ['name-only', 'Name only'], ['user-invocable-only', 'Only when I type it'], ['off', 'Off']];
const MODES = [['', 'As in Claude'], ['manual', 'Ask (manual)'], ['auto', 'Auto'], ['acceptEdits', 'Accept edits'], ['plan', 'Plan'], ['dontAsk', "Don't ask (deny what isn't allowed)"]];
const lines = s => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
const fmtTok = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

export async function wsSettingsDialog(ws, h) {
  const { S, modal, call, api, toast, esc, COLORS, archiveDialog } = h;
  let color = ws.color;
  const globals = await call('globalKeys').catch(() => []);
  const uses = new Set(ws.uses || []);
  const perm = ws.perm || {};
  // Choices made in the Plugins and MCP tabs, kept here so a re-render loses nothing.
  const plugSw = { ...(ws.plugins || {}) };
  const skillSw = { ...(ws.skills || {}) };
  const mcpOff = new Set(ws.mcpOff || []);
  let inv = null;
  const costs = new Map();

  const envRow = (name = '', existing = false) => `<div class="env-row" ${existing ? 'data-existing="1"' : ''}>
      <input class="env-name" value="${esc(name)}" placeholder="NAME" spellcheck="false" ${existing ? 'readonly title="Remove and add again to rename"' : ''}>
      <input class="env-value" type="password" autocomplete="off" placeholder="${existing ? 'saved · type to replace' : 'value'}">
      <button type="button" class="btn env-del" title="Remove">✕</button>
    </div>`;
  const opts = (list, cur) => list.map(([v, label]) => `<option value="${esc(v)}" ${v === (cur || '') ? 'selected' : ''}>${esc(label)}</option>`).join('');
  const profiles = S.profiles || [];

  const form = modal(`<h3>${esc(ws.name)} · settings</h3>
    <div class="tabset" role="tablist">
      <button type="button" role="tab" data-tab="general" class="on">General</button>
      <button type="button" role="tab" data-tab="env">Environment</button>
      <button type="button" role="tab" data-tab="plugins">Plugins and skills</button>
      <button type="button" role="tab" data-tab="perms">MCP and permissions</button>
    </div>

    <div class="tabpanel" data-panel="general">
      <div class="row">
        <label class="field"><span>Name</span><input name="name" value="${esc(ws.name)}" maxlength="60" required></label>
        <div class="field" style="flex:none"><span>Color</span><div class="swatches">${COLORS.map(c => `<button type="button" class="swatch ${c === color ? 'sel' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}</div></div>
      </div>
      <div class="row">
        <label class="field"><span>Prompts from linked Cowork tasks</span><select name="coworkSend"><option value="ask" ${(ws.coworkSend || 'ask') === 'ask' ? 'selected' : ''}>Ask me each time</option><option value="allow" ${ws.coworkSend === 'allow' ? 'selected' : ''}>Send without asking</option></select></label>
      </div>
      <label class="field"><span>Deploy command (runs in a new shell tab from the Deploy button; leave empty to use a package.json "deploy" script if there is one)</span><input name="deploy" value="${esc(ws.deploy || '')}" placeholder="npm run deploy" spellcheck="false" style="font-family:var(--mono)"></label>
      <label class="check-row"><input type="checkbox" name="billable" ${ws.billable ? 'checked' : ''}><span>Billable workstream: count my time while it is selected and polycli is focused, minus Claude's generation time. Monthly totals are in the top-right pill.</span></label>
    </div>

    <div class="tabpanel" data-panel="env" hidden>
      <div class="field"><span>Environment variables for this workstream</span>
        <div id="envRows">${(ws.env || []).map(e => envRow(e.name, true)).join('')}</div>
        <div><button type="button" class="btn" id="envAdd">+ Add variable</button></div>
        <div class="hint" id="envWarn"></div>
        <div class="hint">Every Claude session and new shell in this workstream gets them, on top of your Windows variables (a workstream value wins). Values are stored encrypted for your Windows account and are not shown again. When a session starts they are written into its settings file under %APPDATA%\\polycli\\run, which Claude reads. Running sessions pick up changes on Restart.</div>
      </div>
      <div class="field"><span>Global keys this workstream uses (for your own tracking; every session already has them)</span>
        <div class="key-checks">${globals.length ? globals.map(g => `<label class="key-check"><input type="checkbox" name="uses" value="${esc(g.name)}" ${uses.has(g.name) ? 'checked' : ''}><code>${esc(g.name)}</code>${g.scope === 'machine' ? '<small>machine</small>' : ''}</label>`).join('') : '<span class="hint">No key-like Windows variables found.</span>'}</div>
      </div>
    </div>

    <div class="tabpanel" data-panel="plugins" hidden>
      <div class="hint">What this workstream's Claude sessions load. <b>As in Claude</b> follows <code>claude plugin enable/disable</code>; On and Off apply to this workstream only. Each plugin adds its skills, agents and tool descriptions to every request: the tokens column is that cost.</div>
      <div class="cfg-head"><span id="plugSummary" class="grow">Reading what Claude has installed…</span><button type="button" class="btn" data-refresh title="Read the plugins and skills again">↻ Refresh</button></div>
      <div id="plugList" class="cfg-list"></div>
      <h4 class="cfg-sub">Skills</h4>
      <div class="hint">Your own and this project's skills can be set one by one. <b>Name only</b> keeps a skill usable while leaving its description out of every request; <b>Only when I type it</b> hides it from Claude until you type <code>/name</code>. A plugin's skills follow their plugin.</div>
      <div id="skillList" class="cfg-list"></div>
    </div>

    <div class="tabpanel" data-panel="perms" hidden>
      <h4 class="cfg-sub">MCP servers</h4>
      <div class="hint">A server switched off is denied in this workstream's sessions: none of its tools can be called or take room in the context.</div>
      <div class="cfg-head"><span class="grow" id="mcpSummary"></span><button type="button" class="btn" data-health title="Ask Claude which servers connect (takes a few seconds; also lists claude.ai connectors)">Check connections</button></div>
      <div id="mcpList" class="cfg-list"></div>

      <h4 class="cfg-sub">Permissions</h4>
      <div class="row">
        <label class="field"><span>Profile</span><select name="profile">${profiles.map(p => `<option value="${esc(p.id)}" ${p.id === (ws.profile || 'standard') ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Permission mode</span><select name="mode">${opts(MODES, perm.mode)}</select></label>
      </div>
      <div class="hint" id="profileNote"></div>
      <details class="cfg-rules"><summary>The profile's rules</summary><pre id="profileRules"></pre></details>
      <div class="hint">Rules of this workstream's own, added to its profile's, one per line, in Claude's syntax: <code>Bash(git push *)</code>, <code>WebFetch</code>, <code>mcp__slack</code>. A deny wins over any allow, here or in the project's own settings. Profiles are edited in polycli ⚙.</div>
      <div class="row rules3">
        <label class="field"><span>Deny</span><textarea name="deny" rows="4" spellcheck="false">${esc((perm.deny || []).join('\n'))}</textarea></label>
        <label class="field"><span>Ask first</span><textarea name="ask" rows="4" spellcheck="false">${esc((perm.ask || []).join('\n'))}</textarea></label>
        <label class="field"><span>Allow</span><textarea name="allow" rows="4" spellcheck="false">${esc((perm.allow || []).join('\n'))}</textarea></label>
      </div>
      <label class="field"><span>Extra folders sessions may work in (one per line)</span><textarea name="dirs" rows="2" spellcheck="false">${esc((perm.dirs || []).join('\n'))}</textarea></label>

      <h4 class="cfg-sub">The project's saved rules</h4>
      <div class="hint">Rules "always allow" saved in this folder's <code>.claude/settings.local.json</code>. Rules that hold a password or key, or allow a whole tool, are flagged. Remove takes a rule out of that file.</div>
      <div id="projRules" class="cfg-list"><span class="hint">Reading…</span></div>
    </div>

    <div class="modal-actions"><button type="button" class="btn danger" id="wsArchive" style="margin-right:auto" title="Close its sessions and shells and hide it from the rail">Archive workstream…</button><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div>`,
  async (fd, f) => {
    const env = [...f.querySelectorAll('.env-row')].map(r => {
      const name = r.querySelector('.env-name').value.trim();
      const value = r.querySelector('.env-value').value;
      return r.dataset.existing && !value ? { name } : { name, value };
    }).filter(e => e.name || e.value);
    const before = ws.cfgRev || 0;
    await api.call('updateWorkstream', {
      id: ws.id, name: fd.get('name'), color, env, uses: fd.getAll('uses'), deploy: fd.get('deploy'), coworkSend: fd.get('coworkSend'),
      plugins: plugSw, skills: skillSw, mcpOff: [...mcpOff], profile: fd.get('profile'),
      perm: { mode: fd.get('mode'), deny: lines(fd.get('deny')), ask: lines(fd.get('ask')), allow: lines(fd.get('allow')), dirs: lines(fd.get('dirs')) },
    });
    if ((fd.get('billable') === 'on') !== !!ws.billable) await api.call('setBillable', { workstreamId: ws.id, on: fd.get('billable') === 'on' });
    const w = S.workstreams.find(x => x.id === ws.id);
    const open = S.sessions.filter(s => s.workstreamId === ws.id && s.open && s.state !== 'closed').length;
    toast(open && w && (w.cfgRev || 0) !== before ? `Saved. Restart the workstream's ${open} open session${open === 1 ? '' : 's'} to apply (the notice above each session has a button).` : 'Workstream saved');
  }, { wide: true });
  form.classList.add('settings-modal');

  // Tabs
  const show = tab => {
    form.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    form.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== tab; });
    if ((tab === 'plugins' || tab === 'perms') && !inv) loadInventory(false, false);
    if (tab === 'perms' && !form.dataset.rulesLoaded) { form.dataset.rulesLoaded = '1'; loadProjectRules(); }
  };
  form.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => show(b.dataset.tab));

  // General and Environment
  const rows = form.querySelector('#envRows');
  const warn = () => {
    const names = [...rows.querySelectorAll('.env-name')].map(i => i.value.trim()).filter(n => BILLING_VARS.test(n));
    form.querySelector('#envWarn').innerHTML = names.length ? `<span class="warn-text">${names.map(esc).join(', ')} change${names.length === 1 ? 's' : ''} how Claude itself signs in and bills (an API key here moves this workstream off your Claude plan).</span>` : '';
  };
  form.querySelector('#envAdd').onclick = () => { rows.insertAdjacentHTML('beforeend', envRow()); rows.lastElementChild.querySelector('.env-name').focus(); };
  rows.addEventListener('click', e => { if (e.target.closest('.env-del')) { e.target.closest('.env-row').remove(); warn(); } });
  rows.addEventListener('input', warn);
  warn();
  form.querySelector('#wsArchive').onclick = () => archiveDialog(ws);
  form.querySelectorAll('[data-color]').forEach(b => b.onclick = () => {
    color = b.dataset.color;
    form.querySelectorAll('.swatch').forEach(x => x.classList.toggle('sel', x === b));
  });

  // Plugins and skills
  const effective = p => (p.id in plugSw ? plugSw[p.id] : p.enabled);
  const drawPlugins = () => {
    const list = form.querySelector('#plugList');
    if (!inv) return;
    const on = inv.plugins.filter(effective);
    const known = on.filter(p => costs.get(p.id));
    const tok = known.reduce((n, p) => n + costs.get(p.id).tokens, 0);
    form.querySelector('#plugSummary').textContent = `${on.length} of ${inv.plugins.length} plugins on` + (on.length ? `, about ${fmtTok(tok)} tokens of context${known.length < on.length ? ' (still counting)' : ''}` : '');
    list.innerHTML = inv.plugins.map(p => {
      const c = costs.get(p.id);
      const sel = p.id in plugSw ? (plugSw[p.id] ? 'on' : 'off') : '';
      return `<div class="cfg-row ${effective(p) ? '' : 'off'}" data-plugin="${esc(p.id)}">
        <span class="grow"><b>${esc(p.name)}</b> <small>${esc(p.marketplace)} · ${esc(p.version)}${p.mcpServers.length ? ` · ${p.mcpServers.length} MCP server${p.mcpServers.length === 1 ? '' : 's'}` : ''}</small></span>
        <span class="cfg-tok" title="Tokens it adds to every request">${c === undefined ? '…' : c ? fmtTok(c.tokens) : '?'}</span>
        <select data-plug>${opts([['', `As in Claude (${p.enabled ? 'on' : 'off'})`], ['on', 'On'], ['off', 'Off']], sel)}</select>
      </div>`;
    }).join('') || '<span class="hint">No plugins installed.</span>';
    drawSkills();
  };
  const drawSkills = () => {
    const box = form.querySelector('#skillList');
    if (!inv) return;
    const pluginOn = new Map(inv.plugins.map(p => [p.id, effective(p)]));
    const groups = [['user', 'Your skills'], ['synced', 'Synced from claude.ai'], ['project', "This project's skills"], ['plugin', 'From plugins']];
    box.innerHTML = groups.map(([src, title]) => {
      const list = inv.skills.filter(s => s.source === src && (src !== 'plugin' || pluginOn.get(s.plugin)));
      if (!list.length) return '';
      return `<div class="cfg-group">${esc(title)}</div>` + list.map(s => `<div class="cfg-row" title="${esc(s.description)}">
        <span class="grow"><b>${esc(s.name)}</b> <small>${esc(s.description.slice(0, 110))}${s.description.length > 110 ? '…' : ''}</small></span>
        ${s.switchable ? `<select data-skill="${esc(s.name)}">${opts(SKILL_LEVELS, skillSw[s.name])}</select>${src === 'user' ? ` <button type="button" class="btn" data-copy="${esc(s.path)}" title="Copy this skill into the project's .claude/skills, so it travels with the repository">Copy to project</button>` : ''}`
          : `<small class="hint">with ${esc(s.plugin.split('@')[0])}</small>`}
      </div>`).join('');
    }).join('') || '<span class="hint">No skills found.</span>';
  };
  form.querySelector('#plugList').addEventListener('change', e => {
    const sel = e.target.closest('[data-plug]');
    if (!sel) return;
    const id = sel.closest('[data-plugin]').dataset.plugin;
    if (sel.value) plugSw[id] = sel.value === 'on'; else delete plugSw[id];
    drawPlugins();
  });
  form.querySelector('#skillList').addEventListener('change', e => {
    const sel = e.target.closest('[data-skill]');
    if (!sel) return;
    if (sel.value) skillSw[sel.dataset.skill] = sel.value; else delete skillSw[sel.dataset.skill];
  });
  form.querySelector('#skillList').addEventListener('click', async e => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    b.disabled = true;
    try { const r = await call('copySkillToProject', { workstreamId: ws.id, path: b.dataset.copy }); toast(`Copied to ${r.rel}`); await loadInventory(false, false); } catch { b.disabled = false; }
  });

  // MCP servers
  const drawMcp = () => {
    const box = form.querySelector('#mcpList');
    if (!inv) return;
    const list = inv.mcp;
    form.querySelector('#mcpSummary').textContent = `${list.filter(m => !mcpOff.has(m.name)).length} of ${list.length} servers on for this workstream`;
    box.innerHTML = list.map(m => `<label class="cfg-row ${mcpOff.has(m.name) ? 'off' : ''}">
        <input type="checkbox" data-mcp="${esc(m.name)}" ${mcpOff.has(m.name) ? '' : 'checked'}>
        <span class="grow"><b>${esc(m.name)}</b> <small>${esc(m.source)}${m.plugin && !m.pluginEnabled ? ' · its plugin is off' : ''}</small></span>
        ${m.status ? `<small class="${/connected/i.test(m.status) ? 'ok-text' : 'warn-text'}">${esc(m.status)}</small>` : ''}
      </label>`).join('') || '<span class="hint">No MCP servers configured.</span>';
  };
  form.querySelector('#mcpList').addEventListener('change', e => {
    const c = e.target.closest('[data-mcp]');
    if (!c) return;
    if (c.checked) mcpOff.delete(c.dataset.mcp); else mcpOff.add(c.dataset.mcp);
    drawMcp();
  });

  async function loadInventory(refresh, health) {
    try { inv = await call('claudeInventory', { workstreamId: ws.id, refresh, health }); } catch { return; }
    // Servers switched off earlier but no longer configured stay listed, so they can be switched on again.
    for (const n of mcpOff) if (!inv.mcp.some(m => m.name === n)) inv.mcp.push({ name: n, source: 'no longer configured' });
    drawPlugins(); drawMcp();
    // Context cost, a few plugins at a time (each asks claude).
    const queue = inv.plugins.filter(p => !costs.has(p.id));
    const worker = async () => { for (let p; (p = queue.shift());) { costs.set(p.id, await call('pluginCost', { id: p.id }).catch(() => null)); drawPlugins(); } };
    await Promise.all([worker(), worker(), worker()]);
  }
  form.querySelector('[data-refresh]').onclick = () => { costs.clear(); loadInventory(true, false); };
  form.querySelector('[data-health]').onclick = async e => { e.target.disabled = true; await loadInventory(false, true); e.target.disabled = false; };

  // Permissions
  const profileSel = form.querySelector('[name=profile]');
  const showProfile = () => {
    const p = profiles.find(x => x.id === profileSel.value);
    form.querySelector('#profileNote').textContent = p?.note || '';
    const part = (t, l) => (l?.length ? `${t}:\n  ${l.join('\n  ')}\n` : '');
    form.querySelector('#profileRules').textContent = p ? (part('Deny', p.deny) + part('Ask first', p.ask) + part('Allow', p.allow) + (p.mode ? `Mode: ${p.mode}\n` : '')) || 'No rules: nothing added.' : '';
  };
  profileSel.onchange = showProfile;
  showProfile();

  async function loadProjectRules() {
    const box = form.querySelector('#projRules');
    let r;
    try { r = await call('projectRules', { workstreamId: ws.id }); } catch { box.innerHTML = '<span class="hint">Could not read the project\'s settings.</span>'; return; }
    const flagged = r.rules.filter(x => x.flags.length);
    box.innerHTML = `<div class="hint">${r.rules.length} saved rule${r.rules.length === 1 ? '' : 's'}${flagged.length ? `, ${flagged.length} flagged` : ''}.</div>` + (flagged.length ? flagged : []).map(x => `<div class="cfg-row">
        <span class="grow"><code>${esc(x.display)}</code> <small class="warn-text">${esc(x.flags.join(', '))}</small> <small>${esc(x.list)}</small></span>
        ${x.key ? `<button type="button" class="btn" data-remove-rule="${esc(x.key)}">Remove</button>` : '<small class="hint">in the shared settings.json: edit it in the repository</small>'}
      </div>`).join('') + (r.rules.length > flagged.length ? `<details><summary>All ${r.rules.length} rules</summary><pre>${esc(r.rules.map(x => `${x.list}: ${x.display}`).join('\n'))}</pre></details>` : '');
  }
  form.querySelector('#projRules').addEventListener('click', async e => {
    const b = e.target.closest('[data-remove-rule]');
    if (!b) return;
    b.disabled = true;
    try { await call('removeProjectRule', { workstreamId: ws.id, key: b.dataset.removeRule }); toast('Rule removed from .claude/settings.local.json'); loadProjectRules(); } catch { b.disabled = false; }
  });
}

// polycli ⚙ → Permission profiles: shared by all workstreams.
export function profilesDialog(h) {
  const { S, modal, call, toast, esc } = h;
  let list = structuredClone(S.profiles || []);
  let cur = list[0]?.id;
  const opts = (l, v) => l.map(([k, label]) => `<option value="${esc(k)}" ${k === (v || '') ? 'selected' : ''}>${esc(label)}</option>`).join('');
  const form = modal(`<h3>Permission profiles</h3>
    <div class="hint">Guardrails picked per workstream (⚙ Settings → MCP and permissions). A profile adds deny and ask rules on top of what a project already allows; a deny wins over any allow. Changes reach a workstream's sessions when they restart.</div>
    <div class="profiles"><div class="profile-list" id="profList"></div><div class="profile-edit" id="profEdit"></div></div>
    <div class="modal-actions"><button type="button" class="btn" id="profAdd" style="margin-right:auto">+ New profile</button><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div>`,
  async () => {
    keep();
    await call('setProfiles', { profiles: list });
    toast('Profiles saved');
  }, { wide: true });
  const used = id => S.workstreams.filter(w => (w.profile || 'standard') === id).map(w => w.name);
  const keep = () => {
    const p = list.find(x => x.id === cur);
    const ed = form.querySelector('#profEdit');
    if (!p || !ed.querySelector('[data-f=name]')) return;
    p.name = ed.querySelector('[data-f=name]').value.trim() || p.name;
    p.note = ed.querySelector('[data-f=note]').value;
    for (const k of ['deny', 'ask', 'allow', 'dirs']) p[k] = lines(ed.querySelector(`[data-f=${k}]`).value);
    p.mode = ed.querySelector('[data-f=mode]').value;
  };
  const draw = () => {
    form.querySelector('#profList').innerHTML = list.map(p => `<button type="button" class="${p.id === cur ? 'on' : ''}" data-prof="${esc(p.id)}">${esc(p.name)}<small>${used(p.id).length ? `${used(p.id).length} workstream${used(p.id).length === 1 ? '' : 's'}` : 'unused'}</small></button>`).join('');
    const p = list.find(x => x.id === cur);
    form.querySelector('#profEdit').innerHTML = p ? `
      <label class="field"><span>Name</span><input data-f="name" value="${esc(p.name)}" maxlength="40"></label>
      <label class="field"><span>What it's for</span><input data-f="note" value="${esc(p.note || '')}" maxlength="300"></label>
      <div class="row rules3">
        <label class="field"><span>Deny</span><textarea data-f="deny" rows="7" spellcheck="false">${esc((p.deny || []).join('\n'))}</textarea></label>
        <label class="field"><span>Ask first</span><textarea data-f="ask" rows="7" spellcheck="false">${esc((p.ask || []).join('\n'))}</textarea></label>
        <label class="field"><span>Allow</span><textarea data-f="allow" rows="7" spellcheck="false">${esc((p.allow || []).join('\n'))}</textarea></label>
      </div>
      <div class="row">
        <label class="field"><span>Permission mode</span><select data-f="mode">${opts(MODES, p.mode)}</select></label>
        <label class="field"><span>Extra folders (one per line)</span><textarea data-f="dirs" rows="2" spellcheck="false">${esc((p.dirs || []).join('\n'))}</textarea></label>
      </div>
      ${p.id !== 'standard' ? `<button type="button" class="btn danger" data-del>Delete this profile</button>${used(p.id).length ? ` <small class="hint">${esc(used(p.id).join(', '))} would go back to Standard.</small>` : ''}` : '<small class="hint">Standard can be changed but not deleted.</small>'}` : '';
  };
  form.querySelector('#profList').addEventListener('click', e => { const b = e.target.closest('[data-prof]'); if (!b) return; keep(); cur = b.dataset.prof; draw(); });
  form.querySelector('#profEdit').addEventListener('click', e => {
    if (!e.target.closest('[data-del]')) return;
    list = list.filter(x => x.id !== cur);
    cur = list[0]?.id;
    draw();
  });
  form.querySelector('#profAdd').onclick = () => {
    keep();
    let n = 1; while (list.some(x => x.id === `profile-${n}`)) n++;
    list.push({ id: `profile-${n}`, name: `New profile ${n}`, note: '', allow: [], ask: [], deny: [], mode: '', dirs: [] });
    cur = `profile-${n}`;
    draw();
    form.querySelector('[data-f=name]').select();
  };
  draw();
}
