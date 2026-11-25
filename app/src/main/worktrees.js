'use strict';
// The Worktrees view (docs/design/v0.4.md §7): every git worktree of a workstream's
// repository, whether it is merged, dirty or in use, and removing the ones that are done.
//
// Safety: never removes the main checkout, a worktree with changes, one a polycli session
// works in, or one locked by a process that still runs. A branch is deleted only when its
// work is merged: in git (-d), or by its GitHub pull request when the branch has nothing
// after the PR's last commit (-D, for squash and rebase merges). Otherwise it is kept.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { cleanEnv } = require('./env');
const { normPath } = require('./paths');

const ENV = () => cleanEnv({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' });
const run = (file, args, { cwd, timeout = 15000 } = {}) => new Promise(resolve => execFile(file, args, { cwd, env: ENV(), timeout, windowsHide: true, maxBuffer: 8 << 20 },
  (err, out, errOut) => resolve({ ok: !err, out: String(out || ''), err: String(errOut || (err && err.message) || '') })));
const git = (cwd, args, o) => run('git', ['--no-optional-locks', ...args], { cwd, ...o });

function parsePorcelain(text) {
  const list = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) { if (cur) list.push(cur); cur = null; continue; }
    const [k, ...rest] = line.split(' ');
    const v = rest.join(' ');
    if (k === 'worktree') cur = { path: path.resolve(v), head: null, branch: null, detached: false, bare: false, locked: null, prunable: null };
    else if (!cur) continue;
    else if (k === 'HEAD') cur.head = v;
    else if (k === 'branch') cur.branch = v.replace(/^refs\/heads\//, '');
    else if (k === 'detached') cur.detached = true;
    else if (k === 'bare') cur.bare = true;
    else if (k === 'locked') cur.locked = v || 'locked';
    else if (k === 'prunable') cur.prunable = v || 'prunable';
  }
  if (cur) list.push(cur);
  return list;
}

// "claude session <name> (pid N)": a lock Claude Code put on a worktree it works in.
// It is stale once that process is gone.
function lockInfo(reason) {
  if (!reason) return null;
  const m = /\(pid (\d+)\)/.exec(reason);
  if (!m) return { reason, pid: null, alive: true };   // a lock we can't check stays respected
  let alive = true;
  try { process.kill(+m[1], 0); } catch (e) { alive = e.code === 'EPERM'; }
  return { reason, pid: +m[1], alive };
}

async function defaultBranch(root) {
  const head = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.out.trim()) return head.out.trim();
  for (const b of ['origin/main', 'origin/master', 'main', 'master']) if ((await git(root, ['rev-parse', '--verify', '-q', b])).ok) return b;
  return null;
}

async function mainRoot(dir) {
  const r = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return r.ok ? path.dirname(path.resolve(r.out.trim())) : null;
}

// sessionsIn(path) → names of polycli sessions working there.
async function list(folder, { sessionsIn = () => [] } = {}) {
  const root = await mainRoot(folder);
  if (!root) return { repo: false, rows: [] };
  const wl = await git(root, ['worktree', 'list', '--porcelain']);
  const trees = parsePorcelain(wl.out).filter(t => !t.bare);
  const base = await defaultBranch(root);
  const prs = new Map();
  const gh = await run('gh', ['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,state,url,headRefName,headRefOid'], { cwd: root, timeout: 20000 });
  if (gh.ok) { try { for (const p of JSON.parse(gh.out)) if (!prs.has(p.headRefName)) prs.set(p.headRefName, p); } catch {} }
  const rows = await Promise.all(trees.map(async t => {
    const isMain = normPath(t.path) === normPath(root);
    const exists = fs.existsSync(t.path);
    const st = exists ? await git(t.path, ['status', '--porcelain']) : { ok: false, out: '' };
    const dirty = st.ok ? st.out.split('\n').filter(Boolean).length : 0;
    let ahead = 0, behind = 0, inBase = false;
    if (base && t.branch) {
      const c = await git(root, ['rev-list', '--left-right', '--count', `${base}...${t.branch}`]);
      const m = /(\d+)\s+(\d+)/.exec(c.out);
      if (m) { behind = +m[1]; ahead = +m[2]; }
      inBase = (await git(root, ['merge-base', '--is-ancestor', t.branch, base])).ok;
    }
    const pr = t.branch ? prs.get(t.branch) || null : null;
    const prMerged = pr?.state === 'MERGED';
    const merged = !isMain && !!t.branch && (inBase || prMerged);
    const lock = lockInfo(t.locked);
    const users = sessionsIn(t.path);
    const why = isMain ? 'the main checkout' : !exists ? null : dirty ? `${dirty} uncommitted change${dirty === 1 ? '' : 's'}` : users.length ? `used by ${users.join(', ')}` : lock?.alive ? `locked: ${lock.reason}` : null;
    return {
      path: t.path, name: isMain ? 'main checkout' : path.basename(t.path), branch: t.branch, detached: t.detached, head: (t.head || '').slice(0, 8), main: isMain, exists,
      ahead, behind, dirty, merged, inBase, pr: pr ? { number: pr.number, state: pr.state, url: pr.url } : null,
      lock: lock ? { reason: lock.reason, stale: !lock.alive } : null, users, prunable: t.prunable || (!exists ? 'folder is gone' : null),
      removable: !why, keepReason: why,
      // What Remove does with the branch: delete it (merged) or keep it.
      branchAfter: !t.branch || isMain ? null : inBase ? 'delete' : prMerged && pr.headRefOid && t.head === pr.headRefOid ? 'delete (merged on GitHub)' : 'keep',
    };
  }));
  return { repo: true, root, base, rows: rows.sort((a, b) => (a.main ? -1 : b.main ? 1 : a.name.localeCompare(b.name))) };
}

// Removes one worktree after checking it again; deletes its branch only when merged.
async function remove(folder, wtPath, opts = {}) {
  const { rows, root } = await list(folder, opts);
  const row = rows.find(r => normPath(r.path) === normPath(wtPath));
  if (!row) throw new Error('That worktree is no longer listed');
  if (!row.removable) throw new Error(`Not removed: ${row.keepReason}`);
  if (row.lock?.stale) await git(root, ['worktree', 'unlock', row.path]);
  if (row.exists) {
    const r = await git(root, ['worktree', 'remove', row.path], { timeout: 60000 });
    if (!r.ok) throw new Error(r.err.trim() || 'git worktree remove failed');
  } else {
    await git(root, ['worktree', 'prune']);
  }
  let branch = null;
  if (row.branch && row.branchAfter?.startsWith('delete')) {
    const d = await git(root, ['branch', row.inBase ? '-d' : '-D', row.branch]);
    branch = d.ok ? `deleted ${row.branch}` : `kept ${row.branch}: ${d.err.trim().split('\n')[0]}`;
  } else if (row.branch) branch = `kept ${row.branch}: not merged`;
  return { removed: row.name, branch };
}

async function cleanUpMerged(folder, opts = {}) {
  const { rows } = await list(folder, opts);
  const done = [];
  for (const r of rows.filter(x => x.merged && x.removable)) {
    try { done.push(await remove(folder, r.path, opts)); } catch (e) { done.push({ removed: null, name: r.name, error: e.message }); }
  }
  return done;
}

module.exports = { list, remove, cleanUpMerged, parsePorcelain, lockInfo };
