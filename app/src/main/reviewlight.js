'use strict';
// The code-review light (docs/design/v0.4.md §6): green, orange or red, and why.
//
// polywatch reviews every turn, so the light never asks for a review because a lot of
// code changed. It asks only where a per-turn review can't settle things:
//   1. gaps in polywatch's coverage (skipped or half-checked turns),
//   2. interactions across turns (the same risky file changed in several turns or sessions),
//   3. confirmed defects still open,
//   4. a fragile area (polywatch keeps confirming defects there), which weighs 2 more.
// Pure: polywatch.js gathers the inputs. Learning (factor) only scales reasons 2 and 4.

const ORANGE = 3, RED = 6;                 // score thresholds
const GAP_LINES_FLOOR = 300;               // unchecked lines that are never learned away at push time
const posix = f => String(f || '').replace(/\\/g, '/').replace(/^\.claude\/worktrees\/[^/]+\//, '').replace(/^\.\//, '');

// Changed lines that count toward a review when polywatch isn't there: code and config,
// not tests, docs, lockfiles, generated or binary files. Most of what agents add beyond
// the code is tests and docs, and patch size is no guide to unneeded code (Goel et al.,
// arXiv 2611.34875: AUROC 0.48 for size against 0.72 for their necessity check).
const NOT_CODE = [
  /(^|\/)(tests?|__tests__|specs?|testdata|fixtures?|e2e)\//i,
  /\.(test|spec)\.[a-z0-9]+$/i, /(^|\/)test_[^/]*\.py$/i, /_test\.(go|py|rb|rs|exs?)$/i, /Tests?\.(java|kt|cs|swift)$/,
  /\.(md|mdx|markdown|rst|adoc|txt)$/i, /(^|\/)docs?\//i, /(^|\/)(LICENSE|CHANGELOG|AUTHORS|NOTICE)[^/]*$/i,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|composer\.lock|Gemfile\.lock|packages\.lock\.json)$/i,
  /(^|\/)(dist|build|out|vendor|node_modules|coverage|__snapshots__)\//i, /\.(snap|map|min\.js|min\.css)$/i,
  /\.(png|jpe?g|gif|ico|icns|webp|svg|pdf|zip|woff2?|ttf|otf|mp4|mp3|wav)$/i,
];
const isCodeFile = f => !NOT_CODE.some(re => re.test(posix(f)));
// `git diff --numstat` → code lines added and deleted. Renames read "a => b" or
// "dir/{a => b}/f"; binary files show "-".
function codeLines(numstat) {
  let n = 0;
  for (const line of String(numstat || '').split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m || m[1] === '-') continue;
    // git quotes a path with unusual characters ("docs/caf\303\251.md").
    const file = m[3].replace(/^"(.*)"$/, '$1').replace(/\{[^{}]*? => ([^{}]*)\}/g, '$1').replace(/^.* => /, '').replace(/\/\//g, '/');
    if (isCodeFile(file)) n += +m[1] + +m[2];
  }
  return n;
}

// Did polywatch leave this turn (partly) unchecked? → { lines, why } or null.
function coverageGap(r) {
  const lines = r.features?.changedLines || 0;
  if (r.skipped) {
    // Turns with nothing reviewable (docs, excluded files) or a couple of lines aren't gaps.
    if (/no reviewable files|only \d+ changed lines/i.test(r.skipped)) return null;
    return { lines, why: 'skipped' };
  }
  if (r.reviewer?.error) return { lines, why: 'reviewer failed' };
  const notes = (r.notes || []).join(' ');
  if (/daily cap|too large/i.test(notes)) return { lines, why: 'not reviewed (budget or size)' };
  // A turn is as unchecked as the share of its serious claims nobody checked or settled:
  // the budget running out after most claims were checked leaves little uncovered.
  const serious = [...(r.reviewer?.issues || []), ...(r.compare?.issues || [])].filter(i => /high|medium/i.test(i.severity || ''));
  const adj = r.adjudications || [];
  const settled = adj.filter(a => a.holds === 'yes' || a.holds === 'no').length;
  const open = Math.max(0, serious.length - settled);
  if (!open) return null;
  const share = Math.min(1, open / Math.max(1, serious.length));
  const why = adj.some(a => a.holds === 'uncertain' || a.holds === 'error') ? 'uncertain checks' : /budget reached|not checked/i.test(notes) ? 'budget ran out' : 'claims left unchecked';
  return { lines: Math.round(lines * share), why };
}

// inputs:
//   reviews: polywatch review records in the span (any session for the push span)
//   open: open findings [{ severity, file }]
//   recent: the project's last reviewed turns (for the defect rate)
//   gitLines: changed lines git reports for the span (used when there is no polywatch)
//   polywatch: whether the project has polywatch
//   push: true for the push-time span (red possible), false during work (orange at most)
//   factor: per-project learning, 0.5 (more sensitive) to 2 (less)
function light({ reviews = [], open = [], recent = [], gitLines = 0, polywatch = true, push = false, factor = 1 }) {
  const reasons = [];
  const files = new Set();
  let score = 0;

  // 1. Coverage gaps
  let gapLines = 0;
  const gapFiles = new Set(), whys = new Set();
  if (polywatch) {
    for (const r of reviews) {
      const g = coverageGap(r);
      if (!g || !g.lines) continue;
      gapLines += g.lines * (r.tier === 'HARD' ? 2 : 1);
      whys.add(g.why);
      for (const f of r.files || []) gapFiles.add(posix(f));
    }
  } else if (gitLines) {
    gapLines = gitLines;
  }
  if (gapLines) {
    score += gapLines / 100;
    gapFiles.forEach(f => files.add(f));
    reasons.push({ kind: 'gap', text: polywatch
      ? `polywatch didn't fully check ${gapLines} changed line${gapLines === 1 ? '' : 's'} (${[...whys].join(', ')})${gapFiles.size ? `: ${[...gapFiles].slice(0, 3).join(', ')}${gapFiles.size > 3 ? '…' : ''}` : ''}`
      : `polywatch isn't set up in this project: ${gapLines} changed line${gapLines === 1 ? '' : 's'} of code unreviewed (tests and docs not counted)`, files: [...gapFiles] });
  }

  // 2. Interactions across turns: risky files changed in 3+ turns or by 2+ sessions.
  const byFile = new Map();
  for (const r of reviews) {
    if (r.skipped) continue;
    const f = r.features || {};
    const risky = (f.concurrencyHits || 0) + (f.stateHits || 0) + (f.protocolHits || 0) > 0;
    for (const file of r.files || []) {
      const k = posix(file);
      const e = byFile.get(k) || { turns: 0, sessions: new Set(), risky: false };
      e.turns++; e.sessions.add(r.session); e.risky = e.risky || risky;
      byFile.set(k, e);
    }
  }
  const shared = [...byFile].filter(([, e]) => e.risky && (e.turns >= 3 || e.sessions.size >= 2));
  // 4. A fragile area: confirmed defects per reviewed turn in the project's recent turns.
  const reviewed = recent.filter(r => !r.skipped && !r.reviewer?.error);
  const rate = reviewed.length ? reviewed.reduce((n, r) => n + (r.findings || []).filter(x => x.status === 'confirmed').length, 0) / reviewed.length : 0;
  const fragile = Math.min(1.5, 1 + rate / 2);
  if (shared.length) {
    score += (shared.length * 3 * fragile) / factor;
    shared.forEach(([f]) => files.add(f));
    const many = shared.filter(([, e]) => e.sessions.size >= 2).length;
    reasons.push({ kind: 'interaction', text: `${shared.slice(0, 3).map(([f, e]) => `${f} (${e.turns} turns${e.sessions.size > 1 ? `, ${e.sessions.size} sessions` : ''})`).join(', ')}${shared.length > 3 ? ` and ${shared.length - 3} more` : ''} changed with concurrency or state code${many ? ' by parallel sessions' : ' across turns'}: interactions polywatch reviews one turn at a time`, files: shared.map(([f]) => f) });
  }
  if (rate >= 1 && (shared.length || gapLines)) reasons.push({ kind: 'fragile', text: `polywatch has been confirming ${rate.toFixed(1)} defects per turn here lately`, files: [] });

  // 3. Open defects
  const openHigh = open.filter(o => o.severity === 'high');
  const openMed = open.filter(o => o.severity === 'medium');
  score += openMed.length * 1.5;
  if (open.length) {
    open.forEach(o => o.file && files.add(posix(o.file)));
    reasons.push({ kind: 'open', text: `${openHigh.length ? `${openHigh.length} high` : ''}${openHigh.length && openMed.length ? ' and ' : ''}${openMed.length ? `${openMed.length} medium` : ''}${!openHigh.length && !openMed.length ? `${open.length} low` : ''} confirmed finding${open.length === 1 ? '' : 's'} still open`, files: open.map(o => posix(o.file)).filter(Boolean) });
  }

  let color = score >= RED ? 'red' : score >= ORANGE ? 'orange' : 'green';
  if (push && gapLines >= GAP_LINES_FLOOR && color === 'green') color = 'orange';   // never learned away
  if (!push && color === 'red') color = 'orange';                                  // red is for push time
  if (openHigh.length) color = 'red';                                              // always
  if (color === 'green') reasons.length = 0;
  return { color, score: Math.round(score * 10) / 10, reasons, files: [...files].filter(Boolean).slice(0, 12), level: color === 'red' ? 'high' : 'medium' };
}

// Learning: the last ten /code-review runs of a project → factor in [0.5, 2]. A review
// after an orange or red light that found nothing polywatch hadn't → less sensitive; one
// that found defects polywatch missed → more. Starts after three reviews.
function learnedFactor(history = []) {
  const last = history.slice(-10);
  if (last.length < 3) return 1;
  let steps = 0;
  for (const h of last) {
    if (h.newFound > 0) steps--;
    else if (h.light === 'orange' || h.light === 'red') steps++;
  }
  return Math.max(0.5, Math.min(2, Math.SQRT2 ** Math.max(-2, Math.min(2, steps))));
}

// /code-review findings from the session transcript: the agent's result
// (**file:line — summary**) or a structured findings record.
function reviewFindingsFrom(text) {
  const out = [];
  for (const m of String(text).matchAll(/\*\*([^*\n:]+?\.[\w]+):(\d+)/g)) out.push({ file: posix(m[1].trim()), line: +m[2] });
  return out;
}

module.exports = { light, learnedFactor, coverageGap, reviewFindingsFrom, posix, isCodeFile, codeLines, ORANGE, RED };
