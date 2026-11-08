'use strict';
// Thin wrapper over the claude CLI's background-session commands, plus read-only
// lookups in ~/.claude.json (folder trust, plan name).
//
// `claude --bg` runs through execFile, never inside a pty: the first --bg starts
// Claude's background service, which must not live inside a pseudo-console that
// polycli may close.
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const { cleanEnv } = require('./env');
const { paths, normPath } = require('./paths');

let claudeExe = null;
function exe() {
  if (claudeExe) return claudeExe;
  try {
    claudeExe = execFileSync('where.exe', ['claude'], { encoding: 'utf8', env: cleanEnv() }).split(/\r?\n/)[0].trim();
  } catch {
    throw new Error('claude was not found on PATH');
  }
  return claudeExe;
}

// claude colors its output when FORCE_COLOR is set, even into a pipe (polycli started
// from a Claude Code session inherits FORCE_COLOR=3). The parsers below want plain text.
const stripAnsi = s => String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

function run(args, { cwd, timeout = 60000 } = {}) {
  return new Promise(resolve => {
    execFile(exe(), args, { cwd, env: cleanEnv(), timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? err.code : 0, out: stripAnsi(`${stdout || ''}${stderr || ''}`) }));
  });
}

const bgIdFrom = out => (stripAnsi(out).match(/backgrounded\s*·\s*([0-9a-f]{8})\b/i) || [])[1] || null;

// `claude --bg` prints "backgrounded · 2eb9ba4f · <name> (idle — send a prompt to start)".
// It ignores --session-id; the bgId is the first 8 hex digits of the session id.
// Tells the session how to reach the Cowork / Claude Design task linked to its workstream.
const POST_HINT = 'This session runs in polycli. When the user asks you to send a message, a reply, a brief or a request to the Cowork or Claude Design task linked to this workstream, run in the shell: node "$POLYCLI_POST" "<the message>" (pipe long text on stdin instead). The task reads it with its polycli_inbox tool. You cannot read the task\'s answers this way; they come back to you as prompts relayed by polycli.';

// remote: Remote Control on, under the session's name. It works with --bg (the session
// reports "/remote-control is active") and `claude respawn` keeps it.
async function launchBg({ cwd, name, settingsFile, model, effort, permissionMode, remote }) {
  const args = ['--bg', '-n', name, '--settings', settingsFile];
  if (remote) args.push('--remote-control', name);
  args.push('--append-system-prompt', POST_HINT);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  const r = await run(args, { cwd });
  if (/not trusted/i.test(r.out)) return { ok: false, untrusted: true, out: r.out };
  const bgId = bgIdFrom(r.out);
  if (!bgId) return { ok: false, out: r.out };
  return { ok: true, bgId, out: r.out };
}

const stop = bgId => run(['stop', bgId]);
const respawn = bgId => run(['respawn', bgId]);
const remove = bgId => run(['rm', bgId]);

// All sessions Claude knows about. Takes 1-2 s per call (it starts claude.exe), so
// it is polled slowly; hooks carry the fast path.
async function agents() {
  const r = await run(['agents', '--json', '--all'], { timeout: 20000 });
  try { return JSON.parse(r.out.slice(r.out.indexOf('['))); } catch { return null; }
}

function readClaudeJson() {
  try { return JSON.parse(fs.readFileSync(paths.claudeJson, 'utf8')); } catch { return {}; }
}

// A folder is trusted when it or one of its parents was accepted: accepting the
// prompt in a subfolder of a git repo records the repo root (seen with polycli).
// Keys appear as both C:\a\b and C:/a/b. This is a pre-check only: `claude --bg`
// has the final word, and its "not trusted" answer still opens the trust pane.
function isTrusted(dir) {
  const want = normPath(dir);
  const projects = readClaudeJson().projects || {};
  return Object.entries(projects).some(([k, v]) => {
    if (!v || !v.hasTrustDialogAccepted) return false;
    const base = normPath(k);
    return want === base || want.startsWith(base + '/');
  });
}

function planName() {
  const p = (readClaudeJson().oauthAccount || {}).planDisplayName;
  return p ? `Claude ${p}` : null;
}

module.exports = { exe, run, bgIdFrom, launchBg, stop, respawn, remove, agents, isTrusted, planName };
