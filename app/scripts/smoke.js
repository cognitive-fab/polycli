// npm run smoke: runs the app once in smoke mode with an isolated home and pipe.
// Results: out/smoke.json and out/*.png.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const mode = process.argv[2] || '1';
// One home and pipe per mode, so a run left hanging doesn't block the next one.
const home = path.join(root, 'out', `smoke-home-${mode}`);
fs.rmSync(home, { recursive: true, force: true });
const folder = process.env.POLYCLI_SMOKE_FOLDER || path.join(root, '..', 'spikes', '0ab-bg', 'run', 'cwd');

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ELECTRON_RUN_AS_NODE)/.test(k)));
Object.assign(env, { POLYCLI_SMOKE: mode, POLYCLI_HOME: home, POLYCLI_PIPE: `polycli-smoke-${mode}-${process.pid}`, POLYCLI_BRIDGE_PIPE: `polycli-bridge-smoke-${mode}-${process.pid}`, POLYCLI_SMOKE_FOLDER: folder });

// POLYCLI_SMOKE_EXE=<path to polycli.exe>: the same run against a packaged build.
const exe = process.env.POLYCLI_SMOKE_EXE;
if (exe) env.POLYCLI_SMOKE_OUT = path.join(root, 'out');
const child = exe ? spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(require('electron'), [root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const keep = l => /SMOKE|Error|error|\[ptyhost\]/.test(l) && !/gpu|dxgi|angle/i.test(l);
child.stdout.on('data', d => String(d).split(/\r?\n/).filter(keep).forEach(l => console.log(l)));
child.stderr.on('data', d => String(d).split(/\r?\n/).filter(keep).forEach(l => console.error(l)));
child.on('exit', code => { console.log(`smoke exit ${code}`); process.exit(code ?? 1); });
