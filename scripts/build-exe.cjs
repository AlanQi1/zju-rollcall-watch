// 使用 electron-builder 构建单文件 Windows 便携版 .exe（仅打包白名单源码，不含任何账号或运行时数据）。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const iconPath = path.join(root, 'build', 'icon.ico');

if (!fs.existsSync(iconPath)) {
  execFileSync(process.execPath, [path.join(__dirname, 'generate-icon.mjs')], { cwd: root, stdio: 'inherit' });
}

const builderCli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
if (!fs.existsSync(builderCli)) {
  console.error('未安装 electron-builder，请先运行 npm install');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

execFileSync(process.execPath, [builderCli, '--win', 'portable', '--x64', '--publish', 'never'], {
  cwd: root,
  env,
  stdio: 'inherit',
});

// 清理 electron-builder 生成的中间解压目录与临时文件，保留最终单文件 exe。
const releaseDir = path.join(root, 'release');
const exeName = `RollcallRadar-${pkg.version}-Windows-x64.exe`;
const exePath = path.join(releaseDir, exeName);
for (const entry of fs.readdirSync(releaseDir)) {
  if (entry !== exeName) {
    fs.rmSync(path.join(releaseDir, entry), { recursive: true, force: true });
  }
}

if (!fs.existsSync(exePath)) {
  console.error('打包失败：未找到输出文件 ' + exePath);
  process.exit(1);
}

const sizeMB = (fs.statSync(exePath).size / (1024 * 1024)).toFixed(2);
console.log(`\nSingle-file EXE ready: ${exePath} (${sizeMB} MB)`);
