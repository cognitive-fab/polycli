'use strict';
// Opens VS Code on a folder or file. Code.exe is spawned directly with an argument
// array (no shell): code.cmd would run through cmd.exe, where & or | in a path would
// be interpreted.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { cleanEnv } = require('./env');

function codeExe() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

function gitRoot(dir) {
  return new Promise(resolve => execFile('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { env: cleanEnv(), windowsHide: true, timeout: 5000, encoding: 'utf8' },
    (err, out) => resolve(err ? null : path.resolve(out.trim()))));
}

// target must be an absolute path that exists. mode: 'reuse' (-r) | 'new' (-n).
async function open(target, { mode = 'reuse', root = false } = {}) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || !fs.existsSync(target)) throw new Error('path does not exist');
  const exe = codeExe();
  if (!exe) throw new Error('VS Code (Code.exe) was not found');
  let p = path.resolve(target);
  if (root) p = (await gitRoot(fs.statSync(p).isDirectory() ? p : path.dirname(p))) || p;
  const args = [mode === 'new' ? '-n' : '-r'];
  if (fs.statSync(p).isFile()) args.push('-g');
  args.push(p);
  const child = spawn(exe, args, { env: cleanEnv(), detached: true, stdio: 'ignore', windowsHide: false, shell: false });
  child.unref();
  return { exe, args };
}

module.exports = { open, codeExe };
