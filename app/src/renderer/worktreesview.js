// The Worktrees view of a workstream (docs/design/v0.4.md §7): the repository's git
// worktrees, whether each is merged, dirty or in use, and removing the ones that are done.
// The main process checks everything again before it removes anything (worktrees.js).

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let ctx = null;

export function worktreesView(c) {
  ctx = { el: c.el, ws: c.ws, call: c.call, toast: c.toast };
  c.el.innerHTML = `<div class="pv-scroll"><div class="pv-head"><h2>Worktrees</h2><span class="pv-path" id="wtRoot"></span><span class="grow"></span>
      <button class="btn" data-w="cleanup" title="Remove every worktree that is merged, has no changes and isn't in use, and delete its merged branch">Clean up merged</button>
      <button class="btn" data-w="refresh">↻ Refresh</button></div>
    <div id="wtBody"><div class="pv-empty">Reading the repository's worktrees…</div></div></div>`;
  const me = ctx;
  c.el.onclick = async e => {
    const b = e.target.closest('[data-w]');
    if (!b || ctx !== me) return;
    const a = b.dataset.w, p = b.dataset.path;
    if (a === 'refresh') return load(me);
    if (a === 'code' || a === 'shell') return me.call('worktreeOpen', { workstreamId: me.ws.id, path: p, how: a }).then(() => a === 'shell' && me.toast('Shell opened in the worktree (Main view)')).catch(() => {});
    if (a === 'remove') {
      b.disabled = true;
      try { const r = await me.call('worktreeRemove', { workstreamId: me.ws.id, path: p }); me.toast(`Removed ${r.removed}${r.branch ? `; ${r.branch}` : ''}`); } catch {}
      return load(me);
    }
    if (a === 'cleanup') {
      const rows = me.rows || [];
      const go = rows.filter(r => r.merged && r.removable);
      if (!go.length) return me.toast('Nothing to clean up: no merged worktree is free to remove');
      if (!confirm(`Remove ${go.length} merged worktree${go.length === 1 ? '' : 's'}?\n\n${go.map(r => `${r.name} (${r.branch || 'detached'}; branch ${r.branchAfter})`).join('\n')}`)) return;
      b.disabled = true;
      try { const done = await me.call('worktreeCleanup', { workstreamId: me.ws.id }); me.toast(`Removed ${done.filter(d => d.removed).length}${done.some(d => d.error) ? `; ${done.filter(d => d.error).length} could not be removed` : ''}`); } catch {}
      b.disabled = false;
      return load(me);
    }
  };
  load(me);
}
export function leaveWorktrees() { ctx = null; }

async function load(me) {
  let r;
  try { r = await me.call('worktreeList', { workstreamId: me.ws.id }); } catch { return; }
  if (ctx !== me) return;
  const body = me.el.querySelector('#wtBody');
  if (!r.repo) { body.innerHTML = '<div class="pv-empty"><h3>Not a git repository</h3><p>This workstream\'s folder isn\'t in a git repository, so it has no worktrees.</p></div>'; return; }
  me.rows = r.rows;
  me.el.querySelector('#wtRoot').textContent = `${r.root}${r.base ? ` · compared with ${r.base}` : ''}`;
  const state = x => {
    const out = [];
    if (x.prunable) out.push(`<span class="warn-text">${esc(x.prunable)}</span>`);
    if (x.merged) out.push(`<span class="ok-text">merged</span>`);
    else if (!x.main && x.ahead) out.push(`${x.ahead} ahead`);
    if (x.behind && !x.main) out.push(`${x.behind} behind`);
    if (x.dirty) out.push(`<span class="warn-text">${x.dirty} changed</span>`);
    return out.join(', ') || (x.main ? '' : 'nothing new');
  };
  const use = x => [...x.users.map(esc), x.lock ? (x.lock.stale ? `<span class="hint" title="${esc(x.lock.reason)}">lock left by an ended session</span>` : `<span title="${esc(x.lock.reason)}">locked (running)</span>`) : ''].filter(Boolean).join('<br>') || '—';
  body.innerHTML = `<div class="wt-table"><table class="keys-table"><thead><tr><th>Worktree</th><th>Branch</th><th>State</th><th>Pull request</th><th>In use</th><th></th></tr></thead><tbody>
    ${r.rows.map(x => `<tr>
      <td><b>${esc(x.name)}</b><br><small class="hint">${esc(x.path)}</small></td>
      <td><code>${esc(x.branch || (x.detached ? `detached ${x.head}` : ''))}</code></td>
      <td>${state(x)}</td>
      <td>${x.pr ? `#${x.pr.number} ${esc(x.pr.state.toLowerCase())}` : '—'}</td>
      <td>${use(x)}</td>
      <td class="wt-acts">
        ${x.exists ? `<button class="btn" data-w="code" data-path="${esc(x.path)}" title="Open in VS Code">VS Code</button><button class="btn" data-w="shell" data-path="${esc(x.path)}" title="Open a shell in this worktree">Shell</button>` : ''}
        ${x.removable ? `<button class="btn" data-w="remove" data-path="${esc(x.path)}" title="Remove this worktree; its branch is ${esc(x.branchAfter === 'keep' ? 'kept (not merged)' : 'deleted (merged)')}">Remove</button>` : x.main ? '' : `<small class="hint">kept: ${esc(x.keepReason || '')}</small>`}
      </td></tr>`).join('')}
    </tbody></table></div>
    <p class="hint">Remove takes away the worktree's folder. Its branch is deleted only when its work is merged, into ${esc(r.base || 'the default branch')} or by its pull request on GitHub; otherwise the branch is kept. A worktree with changes, used by a session, or locked by a running process is never removed.</p>`;
}
