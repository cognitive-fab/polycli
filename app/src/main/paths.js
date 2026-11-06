'use strict';
// Where polycli keeps its own files, and where it reads Claude's. polycli never writes
// under ~/.claude or %APPDATA%\Claude.
const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = process.env.POLYCLI_HOME || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'polycli');

const paths = {
  home: HOME,
  data: path.join(HOME, 'data'),          // state.json, events.jsonl
  run: path.join(HOME, 'run'),            // per-session --settings files
  bin: path.join(HOME, 'bin'),            // hook/status helpers, copied out of the app
  pastes: path.join(HOME, 'pastes'),      // images pasted into a pane, saved so their path can be typed
  claudeJson: path.join(os.homedir(), '.claude.json'),
  // Pipe name without the \\.\pipe\ prefix: it is passed on hook command lines, where
  // backslashes would be mangled by the shell.
  pipeName: process.env.POLYCLI_PIPE || `polycli-${(os.userInfo().username || 'user').replace(/[^\w.-]/g, '_')}`,
};

function ensureDirs() {
  for (const d of [paths.data, paths.run, paths.bin, paths.pastes]) fs.mkdirSync(d, { recursive: true });
}

// The same folder can appear as C:\a\b, c:/a/b or C:\a\b\ ; compare on one form.
function normPath(p) {
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function tildify(p) {
  const home = os.homedir();
  return normPath(p).startsWith(normPath(home)) ? '~' + path.resolve(p).slice(home.length) : path.resolve(p);
}

// A path from the renderer or from Cowork: must be absolute and exist.
function checkedDir(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('folder must be an absolute path');
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error(`folder does not exist: ${p}`);
  return path.resolve(p);
}

const pipePath = name => '\\\\.\\pipe\\' + name;

module.exports = { pipePath, paths, ensureDirs, normPath, tildify, checkedDir };
