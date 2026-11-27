// The code-review light (docs/design/v0.4.md §6): each reason alone, a long fully
// checked session staying green, red only at push time (but always for an open high
// finding), and the bounded learning.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { light, learnedFactor, coverageGap, reviewFindingsFrom } = require('../reviewlight');

const turn = (over = {}) => ({ id: 'r' + Math.random(), session: 'A', tier: 'MEDIUM', files: ['src/a.js'], features: { changedLines: 80, concurrencyHits: 0, stateHits: 0, protocolHits: 0 }, reviewer: { issues: [] }, adjudications: [], findings: [], notes: [], ...over });

test('a long session polywatch checked completely stays green', () => {
  const reviews = Array.from({ length: 25 }, (_, i) => turn({ tier: 'HARD', files: [`src/f${i}.js`], features: { changedLines: 300 } }));
  const l = light({ reviews, recent: reviews });
  assert.equal(l.color, 'green');
  assert.equal(l.reasons.length, 0);
});

test('turns skipped for nothing reviewable, or two lines, are not gaps', () => {
  assert.equal(coverageGap(turn({ skipped: 'no reviewable files (all excluded or outside the project)' })), null);
  assert.equal(coverageGap(turn({ skipped: 'only 2 changed lines' })), null);
  const cut = { notes: ['Per-turn budget reached; remaining claims were not checked.'], reviewer: { issues: [{ severity: 'high' }, { severity: 'medium' }] }, adjudications: [{ holds: 'yes' }] };
  assert.deepEqual(coverageGap(turn(cut)), { lines: 40, why: 'budget ran out' }, 'half the serious claims unchecked: half the lines');
  assert.equal(coverageGap(turn({ ...cut, adjudications: [{ holds: 'yes' }, { holds: 'no' }] })), null, 'budget ran out after every serious claim was settled');
  assert.equal(coverageGap(turn({ notes: ['Per-turn budget reached'] })), null, 'nothing serious was raised');
  assert.ok(coverageGap(turn({ reviewer: { error: 'timeout' } })));
});

test('a budget-cut hard turn on many lines: orange during work, red at push time', () => {
  const reviews = [turn({ tier: 'HARD', files: ['src/sessions.js'], features: { changedLines: 500 }, notes: ['Per-turn budget reached; remaining claims were not checked.'], reviewer: { issues: [{ severity: 'high' }, { severity: 'medium' }, { severity: 'medium' }, { severity: 'medium' }] }, adjudications: [{ holds: 'yes' }] })];
  const work = light({ reviews, recent: reviews });
  assert.equal(work.color, 'orange');
  assert.match(work.reasons[0].text, /750 changed lines.*budget ran out.*sessions\.js/);
  assert.deepEqual(work.files, ['src/sessions.js']);
  assert.equal(light({ reviews, recent: reviews, push: true }).color, 'red');
});

test('a risky file changed in three turns is an interaction polywatch does not see', () => {
  const reviews = [1, 2, 3].map(() => turn({ files: ['src/hooks.js'], features: { changedLines: 40, stateHits: 3 } }));
  const l = light({ reviews, recent: reviews, push: true });
  assert.ok(l.reasons.some(r => r.kind === 'interaction' && /hooks\.js \(3 turns\)/.test(r.text)));
  assert.notEqual(l.color, 'green');
  // the same file in three turns without concurrency, state or protocol code is fine
  const calm = [1, 2, 3].map(() => turn({ files: ['README.md'] }));
  assert.equal(light({ reviews: calm, recent: calm, push: true }).color, 'green');
});

test('two sessions changing the same stateful file counts too', () => {
  const reviews = [turn({ session: 'A', files: ['src/state.js'], features: { changedLines: 40, concurrencyHits: 1 } }), turn({ session: 'B', files: ['src/state.js'], features: { changedLines: 40 } })];
  assert.ok(light({ reviews, recent: reviews }).reasons.some(r => /2 sessions/.test(r.text)));
});

test('an open high finding is red even during work and whatever was learned', () => {
  const l = light({ open: [{ severity: 'high', file: 'src/x.js' }], factor: 2 });
  assert.equal(l.color, 'red');
  assert.equal(l.level, 'high');
});

test('open medium findings add up', () => {
  assert.equal(light({ open: [{ severity: 'medium', file: 'a' }] }).color, 'green');
  assert.equal(light({ open: [{ severity: 'medium', file: 'a' }, { severity: 'medium', file: 'b' }] }).color, 'orange');
});

test('learning: less sensitive after quiet reviews, more after misses, within bounds', () => {
  assert.equal(learnedFactor([{ light: 'orange', newFound: 0 }, { light: 'orange', newFound: 0 }]), 1, 'starts after three reviews');
  const quiet = Array.from({ length: 10 }, () => ({ light: 'orange', newFound: 0 }));
  assert.equal(learnedFactor(quiet), 2, 'at most double');
  const misses = Array.from({ length: 10 }, () => ({ light: 'green', newFound: 2 }));
  assert.equal(learnedFactor(misses), 0.5, 'at least half');
  assert.equal(learnedFactor([...misses, ...quiet]), 2, 'only the last ten count');
});

test('learning never silences unchecked code at push time', () => {
  const reviews = [turn({ features: { changedLines: 320 }, notes: ['Per-turn budget reached'], reviewer: { issues: [{ severity: 'high' }, { severity: 'medium' }] } })];
  assert.notEqual(light({ reviews, recent: reviews, push: true, factor: 2 }).color, 'green');
});

test('without polywatch, git changes are the gap', () => {
  const l = light({ polywatch: false, gitLines: 650, push: true });
  assert.equal(l.color, 'red');
  assert.match(l.reasons[0].text, /isn't set up/);
});

test('/code-review findings are read from its Markdown result', () => {
  const f = reviewFindingsFrom('## Findings\n\n**sum.js:1 — Off-by-one**\n\n**app/src/main/hooks.js:42 — race**');
  assert.deepEqual(f, [{ file: 'sum.js', line: 1 }, { file: 'app/src/main/hooks.js', line: 42 }]);
});

test('without polywatch, only code lines count: tests, docs, lockfiles and binaries do not', () => {
  const { codeLines, isCodeFile } = require('../reviewlight');
  const numstat = [
    '120\t30\tsrc/main/sessions.js',
    '400\t0\tsrc/main/__tests__/sessions.test.js',
    '80\t5\tdocs/design/v0.5.md',
    '900\t850\tpackage-lock.json',
    '-\t-\tresources/icon.png',
    '10\t2\tREADME.md',
    '7\t1\t.github/workflows/release.yml',
    '3\t3\tsrc/{old => new}/util.js',
    '50\t0\ttests/test_api.py',
    '4\t0\tpkg/server_test.go',
  ].join('\n');
  assert.equal(codeLines(numstat), 150 + 8 + 6);
  assert.ok(isCodeFile('src/app.ts') && isCodeFile('config/app.yml'));
  assert.ok(!isCodeFile('src/app.spec.ts') && !isCodeFile('CHANGELOG.md') && !isCodeFile('dist/app.min.js'));
  // 400 test lines alone don't reach the push-time floor; 300 code lines do.
  assert.equal(light({ polywatch: false, push: true, gitLines: codeLines('0\t400\ttest/a.test.js') }).color, 'green');
  assert.equal(light({ polywatch: false, push: true, gitLines: codeLines('300\t0\tsrc/a.js') }).color, 'orange');
});
