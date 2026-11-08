// The Tests view: run a project's test and check scripts, see the latest numbers, live
// progress while a run is going, failing tests, and the trend over past runs.
const api = window.polycli;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ctx = null;
let info = null;
let live = null;       // { script, startedAt, pass, fail, tail }
let timer = null;
let showTail = false;

const dur = ms => (ms == null ? '–' : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${String(Math.round(ms / 1000) % 60).padStart(2, '0')}s`);
const ago = at => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const num = n => (n == null ? '–' : n.toLocaleString());

export const leaveTests = () => { ctx = null; clearInterval(timer); };

export async function testsView(c) {
  ctx = c;
  c.el.innerHTML = '<div class="pv-scroll"><div class="pv-empty">Looking at the project…</div></div>';
  await refresh();
}

async function refresh() {
  const c = ctx;
  if (!c) return;
  try { info = await c.call('testsInfo', { workstreamId: c.ws.id }); } catch { return; }
  if (ctx !== c) return;
  live = info.running;
  paint();
}

function bar(e) {
  const total = e.tests || ((e.pass || 0) + (e.fail || 0) + (e.skip || 0));
  if (!total) return '';
  const w = n => `${((n || 0) / total * 100).toFixed(2)}%`;
  return `<div class="tbar" role="img" aria-label="${e.pass} passed, ${e.fail} failed, ${e.skip} skipped"><span class="t-pass" style="width:${w(e.pass)}"></span><span class="t-fail" style="width:${w(e.fail)}"></span><span class="t-skip" style="width:${w(e.skip)}"></span></div>`;
}

function trend(hist) {
  const last = hist.slice(-30);
  if (last.length < 2) return '';
  const max = Math.max(...last.map(e => e.tests || 1), 1);
  return `<div class="ttrend" title="Last ${last.length} runs: green passed, red had failures">${last.map(e => {
    const h = Math.max(8, Math.round(((e.tests || 1) / max) * 100));
    return `<span class="${e.ok ? 't-ok' : 't-bad'}" style="height:${h}%" title="${esc(e.script)} · ${esc(ago(e.at))} · ${e.tests ?? '?'} tests, ${e.fail ?? '?'} failed, ${dur(e.ms)}"></span>`;
  }).join('')}</div>`;
}

function paint() {
  const c = ctx;
  clearInterval(timer);
  const scripts = info.scripts;
  if (!scripts.length) {
    c.el.innerHTML = `<div class="pv-scroll"><div class="pv-head"><h2>Tests</h2></div><div class="pv-empty"><h3>No test scripts found</h3>
      <p>This tab runs the <code>test</code>, <code>check*</code>, <code>verify*</code> and <code>ci</code> scripts in the <code>package.json</code> of the workstream folder${info.name ? '' : ' (there is none here)'}.</p></div></div>`;
    return;
  }
  const hist = info.history;
  const lastBy = name => [...hist].reverse().find(e => e.script === name);
  const latest = hist[hist.length - 1];
  const runBtns = scripts.map(s => {
    const l = lastBy(s.name);
    return `<button class="btn ${s.group === 'tests' ? '' : ''}" data-t="run" data-script="${esc(s.name)}" ${live ? 'disabled' : ''} title="${esc(s.cmd)}">▶ ${esc(s.name)}${l ? `<span class="t-dot ${l.ok ? 't-ok' : 't-bad'}"></span>` : ''}</button>`;
  }).join('');

  let top;
  if (live) {
    top = `<div class="tcard running"><div class="tcard-h"><b>Running ${esc(live.script)}</b><span class="grow"></span><span class="tmeta" id="tElapsed"></span><button class="btn danger" data-t="stop">Stop</button></div>
      <div class="tcounts"><span class="t-pass-n">${live.pass} passed</span><span class="t-fail-n">${live.fail} failed</span></div>
      <pre class="ttail" id="tTail">${esc((live.tail || []).join('\n'))}</pre></div>`;
  } else if (latest) {
    const e = latest;
    top = `<div class="tcard ${e.ok ? 'ok' : 'bad'}"><div class="tcard-h"><b>${e.ok ? '✔ Passing' : e.exit === 'stopped' ? '■ Stopped' : '✖ Failing'}</b><span class="tmeta">${esc(e.script)} · ${esc(ago(e.at))} · ${dur(e.ms)}</span></div>
      <div class="tcounts"><span><b>${num(e.tests)}</b> tests</span><span class="t-pass-n"><b>${num(e.pass)}</b> passed</span><span class="t-fail-n"><b>${num(e.fail)}</b> failed</span><span><b>${num(e.skip)}</b> skipped</span></div>
      ${bar(e)}
      ${e.failed?.length ? `<div class="tfails"><span class="kd-label">Failing</span><ul>${e.failed.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
      ${e.tail ? `<button class="btn" data-t="tail">${showTail ? 'Hide' : 'Show'} the end of the output</button>${showTail ? `<pre class="ttail">${esc(e.tail)}</pre>` : ''}` : ''}</div>`;
  } else {
    top = `<div class="tcard"><div class="tcard-h"><b>No runs yet</b></div><p class="hint">Run a script below. Numbers come from the node:test, TAP or Jest summary the script prints.</p></div>`;
  }

  const rows = [...hist].reverse().slice(0, 12).map(e => `<tr><td>${esc(ago(e.at))}</td><td>${esc(e.script)}</td><td class="${e.ok ? 't-pass-n' : 't-fail-n'}">${e.ok ? 'pass' : e.exit === 'stopped' ? 'stopped' : 'fail'}</td><td>${num(e.tests)}</td><td>${num(e.fail)}</td><td>${dur(e.ms)}</td></tr>`).join('');
  const passRate = hist.length ? Math.round(hist.filter(e => e.ok).length / hist.length * 100) : null;
  c.el.innerHTML = `<div class="pv-scroll"><div class="pv-head"><h2>Tests</h2><span class="pv-path">${esc(info.name || '')}</span><span class="grow"></span><span class="tmeta">${info.files} test file${info.files === 1 ? '' : 's'}</span></div>
    <div class="trun">${runBtns}</div>${top}
    ${hist.length > 1 ? `<div class="tcard"><div class="tcard-h"><b>History</b><span class="tmeta">${passRate}% of ${hist.length} runs passed</span></div>${trend(hist)}
      <table class="keys-table"><thead><tr><th>When</th><th>Script</th><th>Result</th><th>Tests</th><th>Failed</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}</div>`;

  c.el.onclick = async e => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    if (b.dataset.t === 'run') { try { await c.call('testsRun', { workstreamId: c.ws.id, script: b.dataset.script }); } catch { return; } live = { script: b.dataset.script, startedAt: Date.now(), pass: 0, fail: 0, tail: [] }; paint(); }
    else if (b.dataset.t === 'stop') c.call('testsStop', { workstreamId: c.ws.id });
    else if (b.dataset.t === 'tail') { showTail = !showTail; paint(); }
  };
  if (live) {
    const tick = () => { const el = c.el.querySelector('#tElapsed'); if (el) el.textContent = dur(Date.now() - live.startedAt); };
    tick();
    timer = setInterval(tick, 1000);
  }
}

api.onTests(ev => {
  if (!ctx || ev.workstreamId !== ctx.ws.id) return;
  if (ev.type === 'progress' && live) {
    live.pass = ev.pass; live.fail = ev.fail; live.tail = ev.tail;
    const t = ctx.el.querySelector('#tTail');
    if (t) { t.textContent = ev.tail.join('\n'); t.scrollTop = t.scrollHeight; }
    const n = ctx.el.querySelector('.tcounts');
    if (n) n.innerHTML = `<span class="t-pass-n">${ev.pass} passed</span><span class="t-fail-n">${ev.fail} failed</span>`;
  } else if (ev.type === 'start') { live = { script: ev.script, startedAt: ev.startedAt, pass: 0, fail: 0, tail: [] }; if (ctx.el.querySelector('.trun')) paint(); }
  else if (ev.type === 'done') { showTail = false; refresh(); }
});
