// Spike hook + statusLine recorder: appends the event name and the full stdin JSON
// to run/hooks.jsonl. For statusLine it also prints a one-line status. Always exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const event = process.argv[2] || 'unknown';
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run', 'hooks.jsonl');
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let input = raw;
  try { input = JSON.parse(raw); } catch {}
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.appendFileSync(out, JSON.stringify({ ts: new Date().toISOString(), event, pid: process.ppid, input }) + '\n');
  } catch {}
  if (event === 'statusLine') {
    const m = input && input.model ? input.model.display_name : '?';
    process.stdout.write(`polycli-spike · ${m} · v${input && input.version}`);
  }
  process.exit(0);
});
setTimeout(() => process.exit(0), 2000);
