// Electron 启动器：桌面宿主经常传入 RUN_AS_NODE，必须删除而不是赋空串。
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const root = join(__dirname, '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const executable = require('electron');
const child = spawn(executable, [root, ...process.argv.slice(2)], { cwd: root, env, detached: true, windowsHide: true, stdio: 'ignore' });
child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.unref();
