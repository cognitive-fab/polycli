'use strict';
// What Claude Code would give a session in a workstream's folder: installed plugins,
// skills (yours, the project's, each plugin's) and MCP servers. Read-only: polycli
// never writes ~/.claude or ~/.claude.json (docs/design/v0.4.md §1, §2).
//
// `claude plugin list --json` and `claude plugin details` start claude (one to two
// seconds each), so their answers are kept until a Refresh.
const fs = require('fs');
const os = require('os');
const path = require('path');
const claude = require('./claude');
const { normPath } = require('./paths');

const HOME = path.join(os.homedir(), '.claude');
let pluginCache = null;           // { at, list }
const costCache = new Map();      // plugin id → { tokens } (null when unreadable)

async function plugins({ refresh = false } = {}) {
  if (pluginCache && !refresh) return pluginCache.list;
  const r = await claude.run(['plugin', 'list', '--json'], { timeout: 30000 });
  let list = [];
  try { list = JSON.parse(r.out.slice(r.out.indexOf('['))); } catch {}
  list = list.filter(p => p && typeof p.id === 'string').map(p => ({
    id: p.id, name: p.id.split('@')[0], marketplace: p.id.split('@')[1] || '', version: p.version || '', scope: p.scope || '',
    enabled: !!p.enabled, installPath: p.installPath || null,
    // The list reports a plugin's servers only when its manifest names them inline; many
    // keep them in the plugin's own .mcp.json.
    mcpServers: [...new Set([...Object.keys(p.mcpServers || {}), ...pluginFileServers(p.installPath)])],
  }));
  pluginCache = { at: Date.now(), list };
  if (refresh) costCache.clear();
  return list;
}

function pluginFileServers(dir) {
  if (!dir) return [];
  const names = [];
  for (const f of ['.mcp.json', path.join('.claude-plugin', 'plugin.json')]) {
    const s = readJson(path.join(dir, f))?.mcpServers;
    if (s && typeof s === 'object' && !Array.isArray(s)) names.push(...Object.keys(s));
  }
  return names;
}

// "Always-on:   ~220 tok" from `claude plugin details <id>`: what the plugin adds to
// every request. null when the text can't be read (the column then shows "?").
async function pluginCost(id) {
  if (costCache.has(id)) return costCache.get(id);
  const r = await claude.run(['plugin', 'details', id], { timeout: 30000 });
  const m = /Always-on:\s*~?([\d,]+)\s*tok/i.exec(r.out);
  const v = m ? { tokens: Number(m[1].replace(/,/g, '')) } : null;
  costCache.set(id, v);
  return v;
}

// SKILL.md front matter: name and description (a missing name falls back to the folder).
function skillInfo(dir) {
  const file = path.join(dir, 'SKILL.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8').slice(0, 8192); } catch { return null; }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const field = k => {
    if (!fm) return null;
    const m = new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm[1]);
    if (!m) return null;
    let v = m[1].trim();
    if (/^[>|][-+]?$/.test(v)) {   // a folded or literal block: the indented lines after it
      const rest = fm[1].slice(m.index + m[0].length).split(/\r?\n/);
      v = rest.filter((l, i) => /^\s+\S/.test(l) && rest.slice(0, i).every(x => /^\s+\S/.test(x) || !x.trim())).map(l => l.trim()).join(' ');
    }
    return v.replace(/^["']|["']$/g, '');
  };
  return { name: field('name') || path.basename(dir), description: (field('description') || '').slice(0, 400), path: file };
}

function skillsIn(root) {
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return names.filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => skillInfo(path.join(root, d.name))).filter(Boolean);
}

// Every skill a session in `folder` would load, by where it comes from. Your own and
// the project's skills can be switched one by one (skillOverrides); a plugin's follow
// the plugin's own switch.
async function skills(folder, opts) {
  const out = [];
  for (const s of skillsIn(path.join(HOME, 'skills'))) out.push({ ...s, source: 'user', switchable: true });
  for (const s of skillsIn(path.join(HOME, 'skills', 'synced'))) out.push({ ...s, source: 'synced', switchable: true });
  if (folder) for (const s of skillsIn(path.join(folder, '.claude', 'skills'))) out.push({ ...s, source: 'project', switchable: true });
  for (const p of await plugins(opts)) {
    if (!p.installPath) continue;
    for (const s of skillsIn(path.join(p.installPath, 'skills'))) out.push({ ...s, source: 'plugin', plugin: p.id, switchable: false });
  }
  return out;
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

// MCP servers a session in `folder` would get, without starting any: your own
// (~/.claude.json), those for this folder, the project's .mcp.json, and plugins'.
// claude.ai connectors and health come only from `claude mcp list` (slow): `health`.
async function mcpServers(folder, { health = false, ...opts } = {}) {
  const out = new Map();
  const add = (name, source, extra = {}) => { if (!out.has(name)) out.set(name, { name, source, ...extra }); };
  const cj = readJson(path.join(os.homedir(), '.claude.json')) || {};
  for (const n of Object.keys(cj.mcpServers || {})) add(n, 'user');
  if (folder) {
    const key = Object.keys(cj.projects || {}).find(k => normPath(k) === normPath(folder));
    for (const n of Object.keys(cj.projects?.[key]?.mcpServers || {})) add(n, 'this folder');
    for (const n of Object.keys(readJson(path.join(folder, '.mcp.json'))?.mcpServers || {})) add(n, 'project (.mcp.json)');
  }
  for (const p of await plugins(opts)) for (const n of p.mcpServers) add(`plugin:${p.name}:${n}`, 'plugin', { plugin: p.id, pluginEnabled: p.enabled });
  if (health) {
    const r = await claude.run(['mcp', 'list'], { cwd: folder || undefined, timeout: 90000 });
    // "<name>: <command or url> - ✔ Connected" / "! Needs authentication" / "✘ Failed…"
    for (const line of r.out.split(/\r?\n/)) {
      const m = /^(.+?):\s.*\s-\s(.+)$/.exec(line.trim());
      if (!m || /^Checking/.test(line)) continue;
      const name = m[1].trim(), status = m[2].replace(/^[^\w]+/, '').trim();
      if (out.has(name)) out.get(name).status = status;
      else add(name, /^claude\.ai /.test(name) ? 'claude.ai connector' : 'other', { status });
    }
  }
  return [...out.values()];
}

// A user skill copied into the project's .claude/skills, so it travels with the
// repository. Only a folder directly under ~/.claude/skills; never overwrites.
function copySkillToProject(folder, skillFile) {
  const src = path.dirname(path.resolve(String(skillFile)));
  const root = path.join(HOME, 'skills');
  if (normPath(path.dirname(src)) !== normPath(root) || !fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('Only one of your own skills can be copied');
  const dest = path.join(folder, '.claude', 'skills', path.basename(src));
  if (fs.existsSync(dest)) throw new Error(`The project already has a skill folder named ${path.basename(src)}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, errorOnExist: true });
  return { rel: path.relative(folder, dest).replace(/\\/g, '/') };
}

// The project's saved permission rules ("always allow" writes them into
// .claude/settings.local.json; .claude/settings.json is the shared file). Rules holding
// a credential, or allowing a whole tool, are flagged. Credentials are masked in what is
// shown; `key` names a rule without carrying its text to the window.
const CREDENTIAL = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/AWS_SECRET_ACCESS_KEY=\S{20,}/i, 'AWS secret key'],
  [/\b[\w]*(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)\w*=(?!\$)[^\s"')]{8,}/i, 'key or password'],
  [/Bearer\s+[A-Za-z0-9._-]{20,}/, 'bearer token'],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{20,}/, 'API key'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
];
const WHOLE_TOOL = /^(Bash|PowerShell|Write|Edit|WebFetch|WebSearch|Read)$|\((\*|:\*)\)$/;
const mask = s => s.replace(/(AKIA[0-9A-Z]{4})[0-9A-Z]{12}/g, '$1…').replace(/(=)(?!\$)([^\s"')]{4})[^\s"')]{4,}/g, '$1$2…').replace(/(Bearer\s+\S{4})\S+/g, '$1…').replace(/\b((?:sk|pk|rk)-\S{4})\S+/g, '$1…').replace(/(gh[pousr]_\S{4})\S+/g, '$1…');
const ruleKey = (file, list, rule) => require('crypto').createHash('sha1').update(`${file}\0${list}\0${rule}`).digest('hex').slice(0, 16);

function projectRules(folder) {
  const rules = [];
  for (const f of ['settings.local.json', 'settings.json']) {
    const perm = readJson(path.join(folder, '.claude', f))?.permissions;
    for (const list of ['allow', 'ask', 'deny']) for (const rule of perm?.[list] || []) {
      if (typeof rule !== 'string') continue;
      const kinds = [...new Set(CREDENTIAL.filter(([re]) => re.test(rule)).map(([, what]) => what))];
      const flags = kinds.length ? [`credential: ${kinds.join(', ')}`] : [];
      if (list === 'allow' && WHOLE_TOOL.test(rule)) flags.push('allows a whole tool');
      rules.push({ file: f, list: `${f === 'settings.json' ? 'shared ' : ''}${list}`, display: mask(rule), flags, key: ruleKey(f, list, rule), removable: f === 'settings.local.json' });
    }
  }
  // Only rules of the local file can be removed from here; the shared one belongs to the repository.
  return { rules: rules.map(r => (r.removable ? r : { ...r, key: null })) };
}

function removeProjectRule(folder, key) {
  const file = path.join(folder, '.claude', 'settings.local.json');
  const j = readJson(file);
  if (!j?.permissions) throw new Error('No saved rules in this project');
  let removed = 0;
  for (const list of ['allow', 'ask', 'deny']) {
    if (!Array.isArray(j.permissions[list])) continue;
    const next = j.permissions[list].filter(r => ruleKey('settings.local.json', list, r) !== key);
    removed += j.permissions[list].length - next.length;
    j.permissions[list] = next;
  }
  if (!removed) throw new Error('That rule is no longer in the file');
  const tmp = `${file}.polycli.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return { removed };
}

module.exports = { plugins, pluginCost, skills, skillInfo, mcpServers, copySkillToProject, projectRules, removeProjectRule, mask };
