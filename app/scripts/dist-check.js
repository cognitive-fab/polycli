// npm run dist:check (also the last step of npm run dist): checks the Windows build
// before anyone downloads it.
//   - the installer, the portable zip and the unpacked app are there;
//   - polycli.exe and the installer carry polycli's icon (not Electron's) and version;
//   - the packaged app starts and passes the 'packaged' smoke mode (src/main/smoke.js):
//     window, hook helpers, help, bridge extension, a PowerShell shell through node-pty.
// node scripts/dist-check.js --exe "<path to an installed polycli.exe>" runs the last
// check against an installed copy instead.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const { version } = require('../package.json');
const exeArg = process.argv.indexOf('--exe');
const installed = exeArg > 0 ? path.resolve(process.argv[exeArg + 1]) : null;
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

const ps = script => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();
// How far the 32 px icon Windows shows for a file is from the 32 px entry of polycli.ico:
// the mean difference per color channel, 0 to 255. Windows converts the icon on the
// way, so a few units of difference still mean the same picture; Electron's is ~100 away.
const iconDistance = file => Number(ps(`Add-Type -AssemblyName System.Drawing
$a = [System.Drawing.Icon]::ExtractAssociatedIcon('${file}').ToBitmap()
$b = (New-Object System.Drawing.Icon '${path.join(root, 'resources', 'icon', 'polycli.ico')}', 32, 32).ToBitmap()
function W($c, $v) { $v * $c.A / 255 + 255 * (1 - $c.A / 255) }   # the color as seen on white
$sum = 0
for ($x = 0; $x -lt 32; $x++) { for ($y = 0; $y -lt 32; $y++) { $p = $a.GetPixel($x, $y); $q = $b.GetPixel($x, $y)
  $sum += [Math]::Abs((W $p $p.R) - (W $q $q.R)) + [Math]::Abs((W $p $p.G) - (W $q $q.G)) + [Math]::Abs((W $p $p.B) - (W $q $q.B)) } }
[Math]::Round($sum / (32 * 32 * 3), 2)`));
const hasOwnIcon = (file, what) => { const d = iconDistance(file); check(d < 6, `${what} has the polycli icon (difference ${d})`); };

function staticChecks() {
  const setup = path.join(dist, `polycli-Setup-${version}.exe`);
  const zip = path.join(dist, `polycli-${version}-win-x64.zip`);
  const exe = path.join(dist, 'win-unpacked', 'polycli.exe');
  for (const f of [setup, zip, exe, path.join(dist, 'win-unpacked', 'resources', 'polycli-bridge.mcpb')]) check(fs.existsSync(f), `${path.relative(root, f)} exists`);
  if (!fs.existsSync(exe)) return null;
  const info = JSON.parse(ps(`(Get-Item '${exe}').VersionInfo | Select-Object ProductName, FileVersion, CompanyName | ConvertTo-Json`));
  check(info.ProductName === 'polycli' && info.FileVersion === version, `polycli.exe says polycli ${version} (${info.ProductName} ${info.FileVersion}, ${info.CompanyName})`);
  hasOwnIcon(exe, 'polycli.exe');
  if (fs.existsSync(setup)) hasOwnIcon(setup, 'the installer');
  return exe;
}

function runPackaged(exe) {
  return new Promise(resolve => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'polycli-dist-check-'));
    const folder = path.join(home, 'project');
    fs.mkdirSync(folder);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ELECTRON_RUN_AS_NODE|FORCE_COLOR)/.test(k)));
    // Its own home and pipes: a polycli already running on this machine is left alone
    // (the same home would make the new one hand over to it and quit).
    Object.assign(env, {
      POLYCLI_SMOKE: 'packaged', POLYCLI_SMOKE_HIDDEN: '1', POLYCLI_HOME: home, POLYCLI_SMOKE_OUT: home, POLYCLI_SMOKE_FOLDER: folder,
      POLYCLI_PIPE: `polycli-dist-check-${process.pid}`, POLYCLI_BRIDGE_PIPE: `polycli-bridge-dist-check-${process.pid}`,
    });
    const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    const timer = setTimeout(() => child.kill(), 90000);
    let done = false;
    // A path that can't be started (wrong --exe) emits 'error' and no 'exit'.
    child.on('error', e => { log += `could not start ${exe}: ${e.message}\n`; finish(null); });
    child.on('exit', code => finish(code));
    function finish(code) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let report = null;
      try { report = JSON.parse(fs.readFileSync(path.join(home, 'packaged.json'), 'utf8')); } catch {}
      if (!report) console.log(log.split(/\r?\n/).filter(l => l && !/gpu|dxgi|angle/i.test(l)).slice(-20).join('\n'));
      try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
      resolve({ code, report });
    }
  });
}

(async () => {
  const exe = installed || staticChecks();
  if (exe) {
    console.log(`starting ${path.relative(root, exe) || exe} …`);
    const { code, report } = await runPackaged(exe);
    if (!report) check(false, `the packaged app ran its check (exit ${code})`);
    else {
      check(report.packaged, 'it runs as a packaged app');
      check(report.renderer, 'the window loads');
      check(report.helpers, 'the hook helpers are copied out');
      check(report.help, 'the help and its screenshots are there');
      check(report.windowIcon, 'the window icon is there');
      check(report.bridgeExtension, 'the Cowork bridge extension is there');
      check(report.shell, 'a PowerShell shell runs (node-pty)');
      check(report.terminalView, 'the shell shows in the window (xterm)');
      if (report.error) console.log(report.error);
    }
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nthe build is good');
  process.exit(failures.length ? 1 : 0);
})();
