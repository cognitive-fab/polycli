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
