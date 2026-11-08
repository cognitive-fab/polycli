// polycli post: a Claude Code session sends a message to the Cowork or Claude Design
// task linked to its workstream. The task reads it with the polycli_inbox tool.
//   node "$POLYCLI_POST" "message"        (or the message on stdin)
// POLYCLI_SLOT and POLYCLI_PIPE come from the session's settings file, written by polycli.
import net from 'node:net';

const slot = process.env.POLYCLI_SLOT;
const pipe = process.env.POLYCLI_PIPE;
if (!slot || !pipe) {
  console.error('polycli post: this shell is not inside a polycli Claude session (POLYCLI_SLOT/POLYCLI_PIPE are not set). Restart the session in polycli to get them.');
  process.exit(2);
}

const send = text => {
  text = String(text || '').trim();
  if (!text) { console.error('polycli post: the message is empty'); process.exit(2); }
  if (text.length > 20000) { console.error('polycli post: the message is longer than 20000 characters'); process.exit(2); }
  const sock = net.connect('\\\\.\\pipe\\' + pipe);
  sock.setTimeout(3000, () => { console.error('polycli post: polycli did not answer'); process.exit(1); });
  sock.on('error', e => { console.error(`polycli post: cannot reach polycli (${e.code || e.message}). Is it running?`); process.exit(1); });
  sock.on('connect', () => sock.end(JSON.stringify({ event: 'CoworkPost', slot, input: { text } }) + '\n', () => {
    console.log(`Posted to the polycli inbox of this workstream (${text.length} characters). A linked Cowork or Claude Design task reads it with polycli_inbox.`);
    process.exit(0);
  }));
};

const arg = process.argv.slice(2).join(' ');
if (arg) send(arg);
else {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { raw += d; });
  process.stdin.on('end', () => send(raw));
}
