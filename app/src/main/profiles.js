'use strict';
// Permission profiles: named guardrails (deny and ask rules, a default mode, extra
// folders) picked per workstream, and what a workstream adds of its own. They are
// written into each session's settings file (hooks.js), where Claude applies them on
// top of the project's own rules; a deny at any level wins (docs/design/v0.4.md §2).

// The four starting profiles. Two copy rules the user had written by hand (polyaxion,
// polycheck); "Live systems" is new. They are stored in the state and editable.
const DEFAULT_PROFILES = [
  { id: 'standard', name: 'Standard', note: 'Nothing added: Claude\'s own settings and the project\'s rules apply.', allow: [], ask: [], deny: [] },
  {
    id: 'no-publishing', name: 'No publishing', note: 'For experiments that must not leave this PC by accident.', allow: [], ask: [],
    deny: [
      'Bash(gh repo create *)', 'Bash(gh repo edit *)', 'Bash(gh repo fork *)', 'Bash(git remote add *)', 'Bash(git remote set-url *)', 'Bash(npm publish *)', 'Bash(npm publish)',
      'PowerShell(gh repo create *)', 'PowerShell(gh repo edit *)', 'PowerShell(gh repo fork *)', 'PowerShell(git remote add *)', 'PowerShell(git remote set-url *)', 'PowerShell(npm publish *)', 'PowerShell(npm publish)',
      'mcp__plugin_github_github__create_repository', 'mcp__plugin_github_github__fork_repository', 'mcp__plugin_github_github__push_files', 'mcp__plugin_github_github__create_or_update_file',
    ],
  },
  {
    id: 'careful', name: 'Careful', note: 'Asks before reaching the web, pushing, installing or publishing; never deletes files with rm.', allow: [],
    ask: ['WebFetch', 'WebSearch', 'Bash(curl *)', 'Bash(wget *)', 'Bash(git push *)', 'Bash(npm install *)', 'Bash(npm i *)', 'Bash(npm publish *)',
      'PowerShell(curl *)', 'PowerShell(Invoke-WebRequest *)', 'PowerShell(git push *)', 'PowerShell(npm install *)', 'PowerShell(npm publish *)'],
    deny: ['Bash(rm *)', 'PowerShell(Remove-Item *)'],
  },
  {
    id: 'live-systems', name: 'Live systems', note: 'For workstreams that reach servers or cloud accounts: asks before each remote command.', allow: [],
    ask: ['Bash(aws *)', 'Bash(ssh *)', 'Bash(scp *)', 'Bash(gcloud *)', 'Bash(kubectl *)', 'Bash(docker push *)', 'Bash(*prod*)',
      'PowerShell(aws *)', 'PowerShell(ssh *)', 'PowerShell(scp *)', 'PowerShell(gcloud *)', 'PowerShell(kubectl *)', 'PowerShell(docker push *)', 'PowerShell(*prod*)'],
    deny: ['Bash(aws * delete-*)', 'Bash(aws * terminate-*)', 'Bash(aws s3 rm *)', 'Bash(aws s3 rb *)', 'PowerShell(aws * delete-*)', 'PowerShell(aws * terminate-*)', 'PowerShell(aws s3 rm *)', 'PowerShell(aws s3 rb *)'],
  },
];

// Claude's permission modes (claude --help, 2.1.287), minus bypassPermissions: polycli
// never launches sessions that skip prompts.
const MODES = ['', 'manual', 'auto', 'acceptEdits', 'plan', 'dontAsk'];
const RULE = /^[A-Za-z][\w-]*(\([^()\n]{0,500}\))?$/;   // Tool or Tool(pattern); mcp__server__tool
const MAX_RULES = 300;

function cleanRules(list, what) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${what} must be a list of rules`);
  const out = [];
  for (const r of list) {
    const t = String(r ?? '').trim();
    if (!t) continue;
    if (!RULE.test(t)) throw new Error(`"${t.slice(0, 60)}" is not a permission rule (use Tool or Tool(pattern), like Bash(git push *))`);
    if (/^bypassPermissions$/i.test(t)) throw new Error('bypassPermissions is not a rule');
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_RULES) throw new Error(`At most ${MAX_RULES} ${what} rules`);
  return out;
}

function cleanDirs(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error('Extra folders must be a list');
  return [...new Set(list.map(d => String(d ?? '').trim()).filter(Boolean))].slice(0, 20).map(d => {
    if (!require('path').isAbsolute(d) || /[\0\n]/.test(d)) throw new Error(`"${d.slice(0, 60)}" is not an absolute folder path`);
    return d;
  });
}

// A workstream's own permissions, or a profile's rules: { allow, ask, deny, mode, dirs }.
function cleanPermissions(p = {}) {
  if (p.mode !== undefined && !MODES.includes(p.mode)) throw new Error(`Unknown permission mode "${p.mode}"`);
  return { allow: cleanRules(p.allow, 'allow'), ask: cleanRules(p.ask, 'ask'), deny: cleanRules(p.deny, 'deny'), mode: p.mode || '', dirs: cleanDirs(p.dirs) };
}

function cleanProfile(p) {
  const name = String(p?.name ?? '').trim();
  if (!name || name.length > 40) throw new Error('A profile needs a name (40 characters at most)');
  const id = String(p.id || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'profile';
  return { id, name, note: String(p.note ?? '').slice(0, 300), ...cleanPermissions(p) };
}

// MCP server name (as `claude mcp list` or a config shows it) → the prefix of its tool
// names: "claude.ai Google Drive" → claude_ai_Google_Drive, "plugin:github:github" →
// plugin_github_github. A deny rule with that prefix alone removes all the server's tools.
const mcpPrefix = name => 'mcp__' + String(name).replace(/[^A-Za-z0-9_-]/g, '_');

// The `permissions` block of a session's settings file: the profile's rules, the
// workstream's own, and a deny rule per MCP server switched off for the workstream.
// Returns null when there is nothing to add, so the file stays as before.
function sessionPermissions(w, profiles) {
  const prof = (profiles || []).find(p => p.id === (w.profile || 'standard'));
  const own = w.perm || {};
  const uniq = (...lists) => [...new Set(lists.flat().filter(Boolean))];
  const deny = uniq(prof?.deny, own.deny, (w.mcpOff || []).map(mcpPrefix));
  const ask = uniq(prof?.ask, own.ask);
  const allow = uniq(prof?.allow, own.allow);
  const dirs = uniq(prof?.dirs, own.dirs);
  const mode = own.mode || prof?.mode || '';
  if (!deny.length && !ask.length && !allow.length && !dirs.length && !mode) return null;
  const out = {};
  if (allow.length) out.allow = allow;
  if (ask.length) out.ask = ask;
  if (deny.length) out.deny = deny;
  if (mode) out.defaultMode = mode;
  if (dirs.length) out.additionalDirectories = dirs;
  return out;
}

module.exports = { DEFAULT_PROFILES, MODES, cleanPermissions, cleanProfile, cleanRules, mcpPrefix, sessionPermissions };
