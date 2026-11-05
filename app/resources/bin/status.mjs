// polycli statusLine command: node status.mjs <slot> <pipe>
// Forwards the statusLine JSON to polycli (it carries version, model and cwd for the
// pane header), then prints a short status line for the terminal itself.
import net from 'node:net';

const [slot, pipe] = process.argv.slice(2);
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let input = null;
  try { input = JSON.parse(raw); } catch {}
  const model = input?.model?.display_name || '';
  const name = input?.session_name || '';
  process.stdout.write([name, model].filter(Boolean).join(' · '));
  const sock = net.connect('\\\\.\\pipe\\' + pipe);
  const done = () => process.exit(0);
  sock.setTimeout(300, () => { sock.destroy(); done(); });
  sock.on('error', done);
  sock.on('connect', () => sock.end(JSON.stringify({ event: 'statusLine', slot, input }) + '\n', done));
});
setTimeout(() => process.exit(0), 1500).unref();
