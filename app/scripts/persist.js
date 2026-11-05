// npm run persist: hard-kills polycli's main process while a session runs, starts
// polycli again, and checks the session was reattached and still answers.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'out');
const home = path.join(out, 'persist-home');
fs.rmSync(home, { recursive: true, force: true });
for (const f of ['persist.json', 'persist-verify.json']) fs.rmSync(path.join(out, f), { force: true });
const folder = process.env.POLYCLI_SMOKE_FOLDER || path.join(root, '..', 'spikes', '0ab-bg', 'run', 'cwd');
const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ELECTRON_RUN_AS_NODE)/.test(k)));
Object.assign(base, { POLYCLI_HOME: home, POLYCLI_PIPE: 'polycli-persist', POLYCLI_SMOKE_FOLDER: folder });
const electron = require('electron');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const claudeExe = execFileSync('where.exe', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
const agentState = bgId => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k)));
  const list = JSON.parse(execFileSync(claudeExe, ['agents', '--json', '--all'], { env, encoding: 'utf8' }));
  const a = list.find(x => x.id === bgId);
  return a ? a.state || a.status : 'missing';
};

(async () => {
  const first = spawn(electron, [root], { env: { ...base, POLYCLI_SMOKE: 'launch' }, stdio: 'ignore' });
  const t0 = Date.now();
  while (!fs.existsSync(path.join(out, 'persist.json'))) {
    if (Date.now() - t0 > 90000) { first.kill(); throw new Error('launch phase timed out'); }
    await sleep(500);
  }
  const { mainPid, bgId } = JSON.parse(fs.readFileSync(path.join(out, 'persist.json'), 'utf8'));
  console.log('session', bgId, 'before kill:', agentState(bgId));
  execFileSync('taskkill', ['/F', '/PID', String(mainPid)]);   // main process only, no /T
  await sleep(4000);
  console.log('after hard kill of polycli:', agentState(bgId));
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(first.pid)], { stdio: 'ignore' }); } catch {}
  await sleep(1000);
  const second = spawn(electron, [root], { env: { ...base, POLYCLI_SMOKE: 'verify' }, stdio: 'ignore' });
  second.on('exit', code => {
    console.log('verify:', fs.readFileSync(path.join(out, 'persist-verify.json'), 'utf8'));
    process.exit(code ?? 1);
  });
})().catch(e => { console.error(e); process.exit(1); });
