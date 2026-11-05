// polycli hook relay, run by Claude Code for each hook event of a polycli session:
//   node hook.mjs <event> <slot> <pipe>
// Forwards the hook's stdin JSON to polycli's named pipe. It prints nothing (hook
// stdout can be injected into Claude's context) and always exits 0 (exit 2 on Stop
// would block the stop). If polycli is not running, the event is dropped.
import net from 'node:net';

const [event, slot, pipe] = process.argv.slice(2);
const done = () => process.exit(0);
setTimeout(done, 1500).unref();

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let input = null;
  try { input = JSON.parse(raw); } catch {}
  const sock = net.connect('\\\\.\\pipe\\' + pipe);
  sock.setTimeout(300, () => { sock.destroy(); done(); });
  sock.on('error', done);
  sock.on('connect', () => sock.end(JSON.stringify({ event, slot, input }) + '\n', done));
});
process.stdin.on('error', done);
