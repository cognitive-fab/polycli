'use strict';
// Environment for every child process polycli starts. Variables from a surrounding
// Claude session, from Electron or from VS Code must not leak into children: a
// leaked ELECTRON_RUN_AS_NODE turns Code.exe into a bare Node process, and leaked
// CLAUDE* variables make claude think it is nested inside another session.
const DROP = /^(CLAUDE|CLAUDECODE$|ELECTRON_|VSCODE_|ORIGINAL_XDG_|CHROME_)/i;

function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k)) env[k] = v;
  return { ...env, ...extra };
}

module.exports = { cleanEnv };

// Names (never values) of key-like variables saved in Windows: user variables, then
// machine-wide ones. Sessions see these through Claude's background process, so this
// is the list of keys every session already has.
const { execFile } = require('child_process');
const KEYISH = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ENDPOINT)/i;
const SCOPES = [
  ['user', 'HKCU\\Environment'],
  ['machine', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'],
];
function regNames(key) {
  return new Promise(resolve => {
    execFile('reg.exe', ['query', key], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve([]);
      resolve(String(out).split(/\r?\n/).map(l => /^ {4}(\S+) {4}REG_\w+/.exec(l)).filter(Boolean).map(m => m[1]));
    });
  });
}
async function globalKeys() {
  const seen = new Map();
  for (const [scope, key] of SCOPES) {
    for (const name of await regNames(key)) if (KEYISH.test(name) && !seen.has(name.toUpperCase())) seen.set(name.toUpperCase(), { name, scope });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports.globalKeys = globalKeys;
