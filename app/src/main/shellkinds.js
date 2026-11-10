'use strict';
// The kinds of shell a tab can hold: PowerShell (the default), a WSL distribution, or
// another computer over SSH. Each kind builds its own command line, including the way a
// command runs first (a pinned command, Deploy, an agent CLI) and the hidden marker a
// pinned command prints when it ends (pins.js waits for it).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const KINDS = ['pwsh', 'wsl', 'ssh'];
// A host from ~/.ssh/config or user@host[:port-less]; never starts with "-" (an ssh option).
const HOST = /^(?:[\w.-]+@)?[\w][\w.:-]*$/;
const DISTRO = /^[\w][\w.-]*$/;

// The end marker: OSC 633 "polycli-done;1" (success) or ";0", invisible in the terminal.
const PWSH_DONE = "; [Console]::Write([char]27 + ']633;polycli-done;' + [int]$? + [char]7)";
const SH_DONE = "; s=$?; printf '\\033]633;polycli-done;%s\\007' \"$([ $s -eq 0 ] && echo 1 || echo 0)\"";
const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;   // POSIX single-quoting

function wslDistros() {
  return new Promise(resolve => {
    execFile('wsl.exe', ['-l', '-q'], { encoding: 'buffer', windowsHide: true, timeout: 8000 }, (err, out) => {
      if (err || !out) return resolve([]);
      // wsl.exe writes UTF-16LE.
      const list = out.toString('utf16le').replace(/\0/g, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      resolve(list.filter(d => DISTRO.test(d) && !/^docker-desktop/i.test(d)));
    });
  });
}

// Host aliases from ~/.ssh/config (no wildcard patterns).
function sshHosts() {
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
    const out = [];
    for (const m of text.matchAll(/^\s*Host\s+(.+)$/gim)) for (const h of m[1].split(/\s+/)) if (h && !/[*?!]/.test(h) && HOST.test(h) && !out.includes(h)) out.push(h);
    return out;
  } catch { return []; }
}

// Private keys in ~/.ssh: a file with a matching .pub, or a .pem.
function sshKeys() {
  const dir = path.join(os.homedir(), '.ssh');
  try {
    const names = fs.readdirSync(dir);
    return names.filter(n => (names.includes(`${n}.pub`) || /\.pem$/i.test(n)) && fs.statSync(path.join(dir, n)).isFile()).map(n => path.join(dir, n));
  } catch { return []; }
}

// A key path as typed: ~ and $HOME (or $env:USERPROFILE, %USERPROFILE%) stand for the
// home folder, and a bare name is looked up in ~/.ssh.
function keyPath(k) {
  k = String(k || '').trim().replace(/^["']|["']$/g, '');
  if (!k) return null;
  const home = os.homedir();
  k = k.replace(/^(~|\$HOME|\$env:USERPROFILE|%USERPROFILE%)(?=[\\/]|$)/i, home);
  if (!path.isAbsolute(k)) k = path.join(home, '.ssh', k);
  if (!fs.statSync(k, { throwIfNoEntry: false })?.isFile()) throw new Error(`No key file at ${k}`);
  return path.resolve(k);
}

// A whole ssh command pasted in the host box ("ssh -t -i "$HOME\.ssh\id_x" user@host"):
// the host, key and port are taken from it. Other options are refused rather than
// silently dropped.
function parseSsh(line) {
  const words = [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
  if (/^ssh(\.exe)?$/i.test(words[0])) words.shift();
  const out = { host: null, key: null, port: null, user: null };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '-t' || w === '-tt') continue;
    if (w === '-i' || w === '-p' || w === '-l') {
      const v = words[++i];
      if (v === undefined) throw new Error(`${w} needs a value`);
      if (w === '-i') out.key = v; else if (w === '-p') out.port = v; else out.user = v;
    } else if (w.startsWith('-')) throw new Error(`The ssh option ${w} isn't supported here; put it in ~/.ssh/config for that host`);
    else if (!out.host) out.host = w;
    else throw new Error('Only one host, and no remote command (use 📌 Pin for a command)');
  }
  if (out.user && out.host && !out.host.includes('@')) out.host = `${out.user}@${out.host}`;
  return out;
}

// Checks the fields the renderer sends for a new shell; returns what goes on the record.
function checkKind({ kind = 'pwsh', distro, host, dir, key, port }) {
  if (!KINDS.includes(kind)) throw new Error('unknown kind of shell');
  dir = typeof dir === 'string' ? dir.trim() : '';
  if (dir.length > 300 || /[\0\r\n]/.test(dir)) throw new Error('The folder must be one line');
  if (kind === 'wsl') {
    if (!DISTRO.test(distro || '')) throw new Error('Pick a WSL distribution');
    return { kind, distro, host: null, dir: dir || null };
  }
  if (kind === 'ssh') {
    host = typeof host === 'string' ? host.trim() : '';
    if (/\s/.test(host)) {
      const p = parseSsh(host);
      host = p.host || '';
      key = key || p.key;
      port = port || p.port;
    }
    if (!HOST.test(host)) throw new Error('Give a host from your SSH config, user@host, or a whole ssh command');
    port = port ? +port : null;
    if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error('The port must be between 1 and 65535');
    return { kind, distro: null, host, dir: dir || null, key: keyPath(key), port };
  }
  return { kind: 'pwsh', distro: null, host: null, dir: null };
}

// file + args for pty.spawn. `run` is a command to run first; `pinned` adds the marker.
function launch(h, run, pinned) {
  const kind = h.kind || 'pwsh';
  if (kind === 'wsl') {
    const args = ['-d', h.distro, '--cd', h.dir || h.cwd];
    // --exec: wsl hands the script to bash as is (with "--" the default shell would expand
    // it first, and $? in the marker would be gone). -li reads ~/.profile and ~/.bashrc,
    // so tools set up there (nvm, ~/.local/bin) are found, as in the shell you get.
    if (run) args.push('--exec', 'bash', '-lic', `${run}${pinned ? SH_DONE : ''}; exec "\${SHELL:-bash}" -l`);
    return { file: 'wsl.exe', args };
  }
  if (kind === 'ssh') {
    const cd = h.dir ? `cd ${sq(h.dir)} && ` : '';
    const opts = ['-t', ...(h.key ? ['-i', h.key] : []), ...(h.port ? ['-p', String(h.port)] : [])];
    if (!run && !cd) return { file: 'ssh.exe', args: [...opts, h.host] };
    return { file: 'ssh.exe', args: [...opts, h.host, `${cd}${run ? `${run}${pinned ? SH_DONE : ''}; ` : ''}exec "$SHELL" -l`] };
  }
  const args = [...(h.args || ['-NoLogo'])];
  if (run) args.push('-NoExit', '-Command', `${run}${pinned ? PWSH_DONE : ''}`);
  return { file: 'pwsh.exe', args };
}

// What the shell's header shows.
const label = h => (h.kind === 'wsl' ? `WSL · ${h.distro}` : h.kind === 'ssh' ? `ssh ${h.host}${h.port ? ` -p ${h.port}` : ''}${h.key ? ` (${path.basename(h.key)})` : ''}` : 'pwsh');

module.exports = { wslDistros, sshHosts, sshKeys, parseSsh, checkKind, launch, label };
