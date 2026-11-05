'use strict';
// Git and GitHub facts for the session header, and the Commit / Push actions.
// Background reads never take git's index lock (they would break a commit Claude or
// the user is making), never prompt for credentials, and always time out.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { cleanEnv } = require('./env');

const ENV = () => cleanEnv({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' });

function run(file, args, { cwd, timeout = 8000, input } = {}) {
  return new Promise(resolve => {
    const child = execFile(file, args, { cwd, env: ENV(), timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(stdout), err: String(stderr || (err && err.message) || '') });
    });
    // git may exit before reading stdin (e.g. a failing hook): the EPIPE must not
    // become an unhandled error in the main process; the exit code reports it.
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}
const git = (cwd, args, opts) => run('git', ['--no-optional-locks', ...args], { cwd, ...opts });

// `git status --porcelain=v2 --branch`: branch, upstream, ahead/behind, change counts.
async function status(dir) {
  // Paths relative to the repository root, whatever subfolder the session is in.
  const r = await git(dir, ['-c', 'status.relativePaths=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'], { timeout: 5000 });
  if (!r.ok) return null;   // not a repository, or git failed
  const s = { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, changed: 0, untracked: 0, conflicts: 0, files: [] };
  for (const line of r.out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) { const b = line.slice(14); s.detached = b === '(detached)'; s.branch = s.detached ? null : b; }
    else if (line.startsWith('# branch.upstream ')) s.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(line); if (m) { s.ahead = +m[1]; s.behind = +m[2]; } }
    else if (line[0] === '?') { s.untracked++; s.files.push({ x: '??', path: line.slice(2) }); }
    else if (line[0] === 'u') { s.conflicts++; s.files.push({ x: 'UU', path: line.split(' ').slice(10).join(' ') }); }
    else if (line[0] === '1') { s.changed++; s.files.push({ x: line.slice(2, 4), path: line.split(' ').slice(8).join(' ') }); }
    else if (line[0] === '2') { s.changed++; s.files.push({ x: line.slice(2, 4), path: line.split(' ').slice(9).join(' ').split('\t')[0] }); }
  }
  s.files = s.files.slice(0, 200);
  return s;
}

// owner/repo from the origin remote, for https:// and git@ forms. GitHub only.
async function github(dir) {
  const r = await git(dir, ['remote', 'get-url', 'origin'], { timeout: 3000 });
  if (!r.ok) return { origin: false };
  const url = r.out.trim();
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return { origin: true, repo: m ? `${m[1]}/${m[2]}` : null };
}

// The pull request for the current branch, with checks reduced to counts. null when
// there is none, or when gh is missing or not signed in.
async function pullRequest(dir) {
  const r = await run('gh', ['pr', 'view', '--json', 'number,state,url,title,isDraft,statusCheckRollup'], { cwd: dir, timeout: 10000 });
  if (!r.ok) return null;
  try {
    const p = JSON.parse(r.out);
    const checks = { pass: 0, fail: 0, pending: 0 };
    for (const c of p.statusCheckRollup || []) {
      const v = String(c.conclusion || c.state || c.status || '').toUpperCase();
      if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(v)) checks.pass++;
      else if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(v)) checks.fail++;
      else checks.pending++;
    }
    return { number: p.number, state: p.isDraft ? 'DRAFT' : p.state, url: p.url, title: p.title, checks };
  } catch { return null; }
}

async function topLevel(dir) {
  const r = await git(dir, ['rev-parse', '--show-toplevel'], { timeout: 3000 });
  return r.ok ? path.resolve(r.out.trim()) : null;
}

// A `deploy` script in package.json, looked up in the folder and then the repo root.
async function detectDeploy(dir) {
  const root = await topLevel(dir);
  for (const d of [dir, root].filter(Boolean)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
      if (pkg.scripts && typeof pkg.scripts.deploy === 'string') return { command: 'npm run deploy', cwd: d, script: pkg.scripts.deploy };
    } catch {}
  }
  return null;
}

// Commit: optional `git add -A`, then `git commit -F -` (message on stdin, hooks run).
async function commit(dir, message, { all = true } = {}) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('A commit message is required');
  if (all) {
    const a = await git(dir, ['add', '-A'], { timeout: 60000 });
    if (!a.ok) throw new Error(a.err.trim() || 'git add failed');
  }
  const c = await git(dir, ['commit', '-F', '-'], { timeout: 180000, input: message });
  if (!c.ok) throw new Error((c.out + '\n' + c.err).trim() || 'git commit failed');
  return c.out.trim();
}

// Push the current branch; publish it to origin when it has no upstream. Never forced.
async function push(dir) {
  const s = await status(dir);
  if (!s) throw new Error('Not a git repository');
  if (s.detached || !s.branch) throw new Error('Detached HEAD: check out a branch to push');
  const args = s.upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'];
  if (!s.upstream && !(await github(dir)).origin) throw new Error('This repository has no "origin" remote');
  const r = await git(dir, args, { timeout: 180000 });
  if (!r.ok) throw new Error((r.err + '\n' + r.out).trim() || 'git push failed');
  return (r.err + '\n' + r.out).trim();
}

// Only https://github.com/… links leave the app.
function safeGithubUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.toString() : null;
  } catch { return null; }
}

module.exports = { status, github, pullRequest, detectDeploy, commit, push, safeGithubUrl, topLevel };
