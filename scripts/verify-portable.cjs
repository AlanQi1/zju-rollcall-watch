// 验证开发态或单文件打包 exe 的真实 Electron 窗口、IPC、accounts.env 持久化与自动签到模拟链路。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const development = process.argv.includes('--dev');
const executable = development
  ? require('electron')
  : path.join(root, 'release', `RollcallRadar-${pkg.version}-Windows-x64.exe`);

if (!fs.existsSync(executable)) {
  console.error('Executable not found:', executable);
  process.exit(1);
}

const output = fs.mkdtempSync(path.join(os.tmpdir(), development ? 'rollcall-verify-dev-' : 'rollcall-verify-exe-'));
const dataDir = path.join(output, 'data');
const env = { ...process.env, ROLLCALL_TEST_OUTPUT: output, ROLLCALL_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;

const started = Date.now();
const child = spawn(executable, development ? [root, '--self-test'] : ['--self-test'], {
  env,
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (error) => {
  console.error(error.message);
  fs.rmSync(output, { recursive: true, force: true });
  process.exitCode = 1;
});

child.on('exit', (code) => {
  try {
    if (code !== 0) throw new Error('App exited with code ' + code);
    const filename = path.join(output, 'report.json');
    if (fs.statSync(filename).mtimeMs < started) throw new Error('No fresh test report generated');
    const report = JSON.parse(fs.readFileSync(filename, 'utf8'));
    console.log(JSON.stringify({
      mode: development ? 'dev' : 'single-exe',
      passed: report.passed,
      checks: report.assertions.length,
      failures: report.assertions.filter((a) => !a.pass),
      errors: report.errors,
    }, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
