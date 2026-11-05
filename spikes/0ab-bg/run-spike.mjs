// Spikes 0a/0b/0d, headless. It drives a real `claude --bg` session through node-pty
// the way polycli will, and records the answers in run/report.json.
//   node run-spike.mjs            full run (needs the trusted folder run/cwd)
// It uses Haiku and a no-tool "PONG" prompt, and removes the session at the end.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(HERE, 'run');
const CWD = path.join(RUN, 'cwd');
const HOOKS = path.join(RUN, 'hooks.jsonl');
const SETTINGS = path.join(RUN, 'settings.json');
const CLAUDE = execFileSync('where', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();

fs.mkdirSync(CWD, { recursive: true });
fs.rmSync(HOOKS, { force: true });

// A Claude-free environment: the Electron app will not run nested inside a Claude session.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k)));

const report = { claude: CLAUDE, startedAt: new Date().toISOString(), steps: [] };
const step = (name, data) => { report.steps.push({ name, at: new Date().toISOString(), ...data }); console.log(`· ${name}`, JSON.stringify(data)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const save = () => fs.writeFileSync(path.join(RUN, 'report.json'), JSON.stringify(report, null, 2));
const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-_]/g, '');

function claude(args, opts = {}) {
  try {
    return { ok: true, out: execFileSync(CLAUDE, args, { cwd: CWD, env: ENV, encoding: 'utf8', timeout: 60000, ...opts }) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || ''), code: e.status };
  }
}
function agents() {
  const r = claude(['agents', '--json', '--all']);
  try { return JSON.parse(r.out); } catch { return []; }
}
function hooks() {
  if (!fs.existsSync(HOOKS)) return [];
  return fs.readFileSync(HOOKS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}
async function waitFor(pred, ms, every = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = pred(); if (v) return v; await sleep(every); }
  return null;
}

// One attached client: a node-pty running `claude attach <bgId>`.
function attach(bgId, label) {
  const p = pty.spawn(CLAUDE, ['attach', bgId], { name: 'xterm-256color', cols: 120, rows: 40, cwd: CWD, env: ENV });
  const c = { p, raw: '', exited: null, label };
  p.onData(d => { c.raw += d; });
  p.onExit(e => { c.exited = e; });
  return c;
}
const quiet = async (c, ms = 1500, max = 30000) => {
  const t0 = Date.now(); let last = c.raw.length, since = Date.now();
  while (Date.now() - t0 < max) {
    await sleep(200);
    if (c.raw.length !== last) { last = c.raw.length; since = Date.now(); }
    else if (Date.now() - since > ms) return true;
    if (c.exited) return false;
  }
  return false;
};
const tail = (c, n = 600) => stripAnsi(c.raw).replace(/\s+/g, ' ').slice(-n);
function dumpRaw(c) { fs.writeFileSync(path.join(RUN, `${c.label}.raw`), c.raw); }

async function prompt(c, text, tag, pasteGapMs = 150) {
  const before = hooks().length;
  c.p.write(`\x1b[200~${text}\x1b[201~`);
  await sleep(pasteGapMs);
  c.p.write('\r');
  const ups = await waitFor(() => hooks().slice(before).find(h => h.event === 'UserPromptSubmit'), 20000);
  if (!ups) return { tag, pasteGapMs, userPromptSubmit: false, stop: false, screen: tail(c, 500), exited: c.exited };
  const stop = await waitFor(() => hooks().slice(before).find(h => h.event === 'Stop'), 120000);
  const r = { tag, pasteGapMs, userPromptSubmit: !!ups, promptMatches: ups ? (ups.input.prompt || '').trim() === text.trim() : null,
    promptSeen: ups ? ups.input.prompt : null, stop: !!stop };
  if (stop) {
    r.stopInputKeys = Object.keys(stop.input || {});
    const tp = stop.input.transcript_path;
    if (tp && fs.existsSync(tp)) {
      const lines = fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const lastAsst = [...lines].reverse().find(l => l.type === 'assistant');
      const txt = lastAsst && Array.isArray(lastAsst.message?.content) ? lastAsst.message.content.filter(b => b.type === 'text').map(b => b.text).join('') : null;
      r.transcriptFinalAssistantAtStop = txt;
      r.transcriptLastLine = { type: lines.at(-1)?.type, keys: Object.keys(lines.at(-1) || {}) };
      r.transcriptEffort = lastAsst?.effort ?? null;
      r.transcriptModel = lastAsst?.message?.model ?? null;
    }
    for (const k of ['last_assistant_message', 'response', 'message']) if (stop.input[k] !== undefined) r[`stop_${k}`] = stop.input[k];
  }
  return r;
}

let liveBgId = null;
function cleanup() {
  if (!liveBgId) return;
  const id = liveBgId; liveBgId = null;
  step('cleanup', { stop: claude(['stop', id]).out.trim().slice(0, 120), rm: claude(['rm', id]).out.trim().slice(0, 200) });
}

async function main() {
  const sid = crypto.randomUUID();
  const name = 'polycli-spike · pong';

  // 1. Launch.
  let t0 = Date.now();
  const launch = claude(['--bg', '--session-id', sid, '-n', name, '--model', 'haiku', '--settings', SETTINGS]);
  step('launch', { ms: Date.now() - t0, ok: launch.ok, out: launch.out.trim().slice(0, 400) });
  if (/not trusted/i.test(launch.out)) {
    report.blocked = `Workspace not trusted: run \`claude\` once in ${CWD}, accept the trust prompt, /exit, then rerun.`;
    save(); console.error(report.blocked); process.exit(2);
  }
  const ag = agents().find(a => a.sessionId === sid);
  const bgId = ag?.id || (launch.out.match(/\b([0-9a-f]{8})\b/) || [])[1];
  step('agents-after-launch', { found: !!ag, entry: ag, bgIdEqualsUuidPrefix: bgId === sid.slice(0, 8), bgId });
  if (!bgId) { save(); throw new Error('no bgId'); }
  liveBgId = bgId;

  // 2. Attach immediately (race), wait for the TUI.
  let a1 = attach(bgId, 'attach1');
  t0 = Date.now();
  await quiet(a1, 2000, 30000);
  step('attach1-ready', { ms: Date.now() - t0, exited: a1.exited, bracketedPasteEnabled: a1.raw.includes('\x1b[?2004h'), screen: tail(a1, 400) });
  if (a1.exited) {
    // Attach raced the launch: record it, then retry once after 2 s.
    dumpRaw(a1);
    await sleep(2000);
    a1 = attach(bgId, 'attach1b');
    await quiet(a1, 2000, 30000);
    step('attach1-retry', { exited: a1.exited, bracketedPasteEnabled: a1.raw.includes('\x1b[?2004h'), screen: tail(a1, 400) });
    if (a1.exited) throw new Error('attach exits immediately');
  }

  // 3. Prompts: single line, then multi-line.
  step('prompt-single', await prompt(a1, 'Reply with exactly the word PONG and nothing else.', 'single'));
  step('prompt-multiline', await prompt(a1, 'This is line one of a pasted prompt.\nReply with exactly the word PONG2 and nothing else.', 'multi'));
  await quiet(a1, 1000, 5000);

  // 4. The left-arrow key on an empty prompt ("← returns to agent view").
  const beforeLeft = a1.raw.length;
  a1.p.write('\x1b[D');
  await quiet(a1, 1500, 8000);
  step('left-arrow', { exited: a1.exited, screenAfter: stripAnsi(a1.raw.slice(beforeLeft)).replace(/\s+/g, ' ').slice(-500) });
  dumpRaw(a1);

  // 5. Simulate a polycli crash: kill the attach client, check the session survives,
  //    and count statusLine events while nobody is attached.
  const slBefore = hooks().filter(h => h.event === 'statusLine').length;
  try { a1.p.kill(); } catch {}
  await sleep(8000);
  const slDetached = hooks().filter(h => h.event === 'statusLine').length - slBefore;
  step('after-client-kill', { agent: agents().find(a => a.sessionId === sid), statusLineEventsWhileDetached: slDetached });

  // 6. Reattach after the client was killed.
  const a2 = attach(bgId, 'attach2');
  await quiet(a2, 2000, 30000);
  step('reattach', { exited: a2.exited, screen: tail(a2, 300) });
  try { a2.p.kill(); } catch {}

  // 7. Close (stop) and reopen (attach): do the --settings hooks survive?
  const stop = claude(['stop', bgId]);
  await sleep(2000);
  step('stop', { ok: stop.ok, out: stop.out.trim().slice(0, 200), agent: agents().find(a => a.sessionId === sid) });
  const hBefore = hooks().length;
  const a3 = attach(bgId, 'attach3');
  await quiet(a3, 2000, 40000);
  step('reopen-after-stop', { exited: a3.exited, hooksSinceReopen: hooks().slice(hBefore).map(h => h.event + (h.input?.source ? `:${h.input.source}` : '')), screen: tail(a3, 300) });
  step('prompt-after-reopen', await prompt(a3, 'Reply with exactly the word PONG3 and nothing else.', 'after-reopen'));
  dumpRaw(a3);
  try { a3.p.kill(); } catch {}

  // 8. Restart (respawn): do the hooks survive that too?
  const rs = claude(['respawn', bgId]);
  await sleep(3000);
  step('respawn', { ok: rs.ok, out: rs.out.trim().slice(0, 300), agent: agents().find(a => a.sessionId === sid) });
  const a4 = attach(bgId, 'attach4');
  await quiet(a4, 2000, 40000);
  step('prompt-after-respawn', await prompt(a4, 'Reply with exactly the word PONG4 and nothing else.', 'after-respawn'));
  dumpRaw(a4);
  try { a4.p.kill(); } catch {}

  // 9. Hook payload shapes (one example of each event).
  const seen = {};
  for (const h of hooks()) if (!seen[h.event]) seen[h.event] = h.input;
  report.hookExamples = seen;
  report.hookCounts = hooks().reduce((m, h) => (m[h.event] = (m[h.event] || 0) + 1, m), {});

  report.finishedAt = new Date().toISOString();
}

main()
  .catch(e => { report.error = String(e.stack || e); console.error(e); process.exitCode = 1; })
  .finally(() => {
    cleanup();
    save();
    console.log('report: ' + path.join(RUN, 'report.json'));
    setTimeout(() => process.exit(), 500);
  });
