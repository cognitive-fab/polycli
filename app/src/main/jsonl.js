'use strict';
// Reading a JSON-lines file that another process appends to (a Claude transcript, the
// polywatch ledger): only what was added since the last read, and only complete lines.
// A line still being written has no newline yet; it is left for the next read, so a
// record is never parsed half-written and then skipped for good.
const fs = require('fs');

const CHUNK = 1 << 20;

// → { lines: [string], offset } where offset is just past the last complete line.
// A file shorter than `offset` was rewritten: it is read again from the start
// (`restarted: true`).
async function readNewLines(file, offset = 0) {
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch { return { lines: [], offset, missing: true }; }
  try {
    const { size } = await fh.stat();
    let restarted = false;
    if (size < offset) { offset = 0; restarted = true; }
    const lines = [];
    let pos = offset, carry = Buffer.alloc(0);
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      let data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let start = 0, nl;
      while ((nl = data.indexOf(10, start)) !== -1) {
        const line = data.subarray(start, nl).toString('utf8').replace(/\r$/, '');
        if (line) lines.push(line);
        start = nl + 1;
      }
      carry = Buffer.from(data.subarray(start));
    }
    return { lines, offset: pos - carry.length, restarted };
  } finally {
    await fh.close();
  }
}

module.exports = { readNewLines };
