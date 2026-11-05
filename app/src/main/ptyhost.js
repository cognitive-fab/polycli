'use strict';
// Runs inside an Electron utilityProcess. Owns every pseudo-console (node-pty /
// ConPTY), so a renderer reload doesn't drop terminals. Messages from main:
//   {op:'spawn', id, file, args, cwd, env, cols, rows}  {op:'write', id, data}
//   {op:'resize', id, cols, rows}  {op:'kill', id}
// Messages to main: {op:'data', id, data}  {op:'exit', id, code}  {op:'error', id, message}
const pty = require('node-pty');

const terms = new Map();
const post = m => process.parentPort.postMessage(m);

process.parentPort.on('message', ({ data: m }) => {
  try {
    if (m.op === 'spawn') {
      if (terms.has(m.id)) return;
      const p = pty.spawn(m.file, m.args, { name: 'xterm-256color', cols: m.cols || 120, rows: m.rows || 32, cwd: m.cwd, env: m.env });
      terms.set(m.id, p);
      p.onData(data => post({ op: 'data', id: m.id, data }));
      p.onExit(({ exitCode }) => { terms.delete(m.id); post({ op: 'exit', id: m.id, code: exitCode }); });
    } else if (m.op === 'write') {
      terms.get(m.id)?.write(m.data);
    } else if (m.op === 'resize') {
      const p = terms.get(m.id);
      if (p && m.cols > 1 && m.rows > 1) p.resize(m.cols, m.rows);
    } else if (m.op === 'kill') {
      terms.get(m.id)?.kill();
    }
  } catch (e) {
    post({ op: 'error', id: m.id, message: String(e && e.message || e) });
  }
});
