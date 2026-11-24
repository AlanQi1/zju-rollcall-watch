import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { allowDirectHosts } from '../http.js';
import { ConfigStore, normalizeConfig } from '../config.js';
import { RollcallWatcher } from '../watcher.js';
import { accountsFile, deleteAccount, ensureAccountsTemplate, resolveAccounts, saveAccount } from '../accounts.js';

allowDirectHosts();

const require = createRequire(import.meta.url);
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, screen, nativeImage, nativeTheme, powerMonitor } = require('electron');
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SELF_TEST = process.argv.includes('--self-test');
const tempSelfTestDir = SELF_TEST && !process.env.ROLLCALL_DATA_DIR ? mkdtempSync(join(tmpdir(), 'rollcall-selftest-')) : '';
const DATA = process.env.ROLLCALL_DATA_DIR || tempSelfTestDir || (app.isPackaged ? join(app.getPath('appData'), 'ZjuRollcallWatch') : join(ROOT, 'data'));
const extraEnvFiles = (app.isPackaged || SELF_TEST) ? [] : [join(ROOT, '.env')];
const accountOptions = { extraFiles: extraEnvFiles };

app.setName('签到雷达');
app.setAppUserModelId('cn.zju.rollcall.watch');
app.setPath('userData', join(DATA, 'app-state'));
if (!SELF_TEST && !app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
if (process.argv.includes('--quit')) { app.quit(); process.exit(0); }

ensureAccountsTemplate(DATA);
const config = new ConfigStore(DATA);
config.ensureFile();
// 自测启动与真实监听分开：模拟提交结束后恢复原设置。
const testConfigSnapshot = SELF_TEST ? config.load() : null;
if (SELF_TEST) config.patch({ autoAnswer: false });

let mainWindow, tray, quitting = false;
const popups = [];
const report = { version: 3, assertions: [], errors: [] };
const watcher = new RollcallWatcher(config, DATA, {
  notify: showGlassPopup,
  accountProvider: () => resolveAccounts(DATA, accountOptions),
});

// NativeImage 不解码 SVG。直接生成 BGRA 位图，确保任务栏和系统托盘都有图标。
function appIcon(size = 64) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const nx = x / size, ny = y / size;
    const circle = (nx - .5) ** 2 + (ny - .5) ** 2 < .23;
    if (!circle) continue;
    const first = nx >= .25 && nx < .47 && Math.abs(ny - (.51 + (nx - .25))) < .055;
    const second = nx >= .44 && nx <= .77 && Math.abs(ny - (.70 - (nx - .44))) < .055;
    const white = first || second;
    pixels[i] = white ? 255 : 237;
    pixels[i + 1] = white ? 255 : 99;
    pixels[i + 2] = white ? 255 : 29;
    pixels[i + 3] = 255;
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
}

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}

function guardWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('render-process-gone', (_event, details) => watcher.log('error', `界面进程结束：${details.reason}`));
  win.webContents.on('preload-error', (_event, _path, error) => { report.errors.push(error.message); watcher.log('error', `界面连接失败：${error.message}`); });
}

// 主窗口使用原生非透明圆角阴影，彻底消除 transparent + acrylic 在 Win11 圆角外产生的方形残边。
async function createMain() {
  mainWindow = new BrowserWindow({
    frame: false, transparent: false, backgroundColor: '#f6f8fb', roundedCorners: true, hasShadow: true,
    width: 1040, height: 720, minWidth: 840, minHeight: 600,
    show: false, title: '签到雷达', icon: appIcon(), autoHideMenuBar: true,
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  guardWindow(mainWindow);
  mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); mainWindow.hide(); } });
  await mainWindow.loadFile(join(HERE, 'index.html'));
  if (!process.argv.includes('--background')) mainWindow.show();
}

function repositionPopups() {
  const { workArea } = screen.getPrimaryDisplay();
  popups.filter((p) => !p.win.isDestroyed()).forEach((p, index) => {
    p.win.setPosition(Math.round(workArea.x + workArea.width - 456), Math.round(workArea.y + workArea.height - 284 - index * 266), false);
  });
}

async function showGlassPopup(payload) {
  // 各账号同时签到不覆盖：最多显示三张卡片，其余仍在主界面保留。
  if (popups.length >= 3) throw new Error('当前已有三张提醒，请先处理；其余签到仍在主界面显示并在下一轮重试提醒');
  // 弹窗透明但禁用 DWM hasShadow / thickFrame / acrylic，由 CSS 在透明留白区内绘制柔和阴影，圆角外零残边。
  const win = new BrowserWindow({
    frame: false, transparent: true, backgroundColor: '#00000000',
    hasShadow: false, thickFrame: false, roundedCorners: false,
    width: 448, height: 276, useContentSize: true,
    alwaysOnTop: true, skipTaskbar: true, resizable: false, maximizable: false, minimizable: false,
    show: false, focusable: true,
    webPreferences: { preload: join(HERE, 'popup-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  const entry = { win, payload };
  popups.push(entry);
  guardWindow(win);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.on('closed', () => { const index = popups.indexOf(entry); if (index >= 0) popups.splice(index, 1); repositionPopups(); });
  // 等预载和 renderer 注册好 onShow，再发消息，消除启动时吞掉提醒的竞态。
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('提醒界面加载超时')); }, 12000);
    const listener = (event) => { if (event.sender === win.webContents) { cleanup(); resolve(); } };
    function cleanup() { clearTimeout(timer); ipcMain.removeListener('popup-ready', listener); }
    ipcMain.on('popup-ready', listener);
    win.once('closed', () => { cleanup(); reject(new Error('提醒窗口已关闭')); });
  });
  try {
    await win.loadFile(join(HERE, 'popup.html'));
    await ready;
    win.webContents.send('show-popup', { ...payload, sound: false });
    repositionPopups();
    win.showInactive();
    if (payload.sound) shell.beep();
    return { shown: true };
  } catch (error) { if (!win.isDestroyed()) win.destroy(); throw error; }
}

async function testPopup() {
  const c = config.load();
  return showGlassPopup({ type: '提醒测试', title: '这是一条测试通知', teacher: '这里将显示发起签到的老师', account: '测试账号 · 非真实签到', startedAt: '刚刚', url: 'https://courses.zju.edu.cn/user/index', sound: c.notifySound, seconds: c.notifySeconds, test: true });
}

// 单文件便携 exe 运行时 process.execPath 指向临时解压目录，必须优先使用 PORTABLE_EXECUTABLE_FILE。
const executablePath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
const loginArgs = () => (app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) ? ['--background'] : [ROOT, '--background'];
function autostart() { return app.getLoginItemSettings({ path: executablePath(), args: loginArgs() }).openAtLogin; }
function setAutostart(enabled) {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: executablePath(), args: loginArgs() });
  return autostart();
}

function refreshTray() {
  if (!tray) return;
  const status = watcher.getStatus();
  tray.setToolTip(`签到雷达 · ${status.running ? (status.lastError ? '连接异常' : '正在监听') : '已暂停'}${status.activeRollcalls.length ? ` · ${status.activeRollcalls.length}项待签到` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开签到雷达', click: showMain },
    { label: '立即检查', click: () => { watcher.checkOnce().catch((e) => watcher.log('error', e.message)); } },
    { label: '测试提醒', click: () => { testPopup().catch((e) => watcher.log('error', e.message)); } },
    { label: watcher.running ? '暂停监听' : '开始监听', click: () => watcher.running ? watcher.stop() : watcher.start() },
    { type: 'separator' },
    { label: '开机启动', type: 'checkbox', checked: autostart(), click: (item) => { setAutostart(item.checked); refreshTray(); } },
    { type: 'separator' }, { label: '退出软件', click: () => app.quit() },
  ]));
}

async function openExternal(url) {
  const target = new URL(String(url));
  if (target.protocol !== 'https:' || !(target.hostname === 'zju.edu.cn' || target.hostname.endsWith('.zju.edu.cn'))) throw new Error('仅支持打开浙大课程页面');
  await shell.openExternal(target.href);
  return { ok: true };
}

function registerIpc() {
  const onlyMain = (event) => { if (event.sender !== mainWindow?.webContents) throw new Error('窗口来源错误'); };
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => { onlyMain(event); return fn(...args); });
  ipcMain.on('window-minimize', (event) => { onlyMain(event); mainWindow.minimize(); });
  ipcMain.on('window-maximize', (event) => { onlyMain(event); mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); });
  ipcMain.on('window-close', (event) => { onlyMain(event); mainWindow.close(); });
  ipcMain.on('show-main', showMain);
  ipcMain.on('popup-dismiss', (event) => { const popup = popups.find((p) => p.win.webContents === event.sender); popup?.win.close(); });
  handle('get-status', () => watcher.getStatus());
  handle('get-logs', () => watcher.logs);
  handle('check-now', () => {
    for (const [key, state] of watcher.accountStates) watcher.accountStates.set(key, { ...state, retryAt: 0 });
    return watcher.checkOnce();
  });
  handle('toggle-watch', () => { watcher.running ? watcher.stop() : watcher.start(); return watcher.getStatus(); });
  handle('test-popup', testPopup);
  handle('update-config', (patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('设置格式错误');
    const allowed = ['intervalMs', 'notify', 'notifySound', 'notifySeconds', 'renotifyMs', 'autoAnswer', 'autoDefaultLocation', 'autoFallback'];
    const values = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key)));
    const next = normalizeConfig({ ...config.load(), ...values });
    if (next.autoDefaultLocation && !watcher.locations.resolve(next.autoDefaultLocation)) throw new Error('默认签到位置未识别，请选择列表点位或填写经度,纬度');
    if (next.autoAnswer) {
      const accounts = watcher.accountProvider().accounts.filter((a) => a.enabled !== false && a.autoAnswer !== false);
      if (!accounts.length) throw new Error('请先添加并启用至少一个参与自动签到的账号');
      for (const account of accounts) {
        if (!watcher.locations.resolve(account.location || next.autoDefaultLocation)) throw new Error(`${account.label} 尚未设置有效签到位置；请先设置默认位置或编辑该账号`);
      }
      if (watcher.autoSigner.storageError) throw new Error(watcher.autoSigner.storageError);
    }
    config.patch(values);
    watcher.reschedule(); watcher.changed();
    return watcher.getStatus();
  });
  handle('get-locations', () => watcher.locations.all().map(({ id, name, campus, lon, lat }) => ({ id, name, campus, lon, lat })));
  handle('get-autostart', autostart);
  handle('set-autostart', (enabled) => { const value = setAutostart(enabled); refreshTray(); return value; });
  handle('open-accounts', async () => { mkdirSync(DATA, { recursive: true }); const error = await shell.openPath(DATA); if (error) throw new Error(error); return { ok: true }; });
  handle('open-env-file', async () => { ensureAccountsTemplate(DATA); const error = await shell.openPath(accountsFile(DATA)); if (error) throw new Error(error); return { ok: true }; });
  handle('save-account', (input) => {
    if (!input || typeof input !== 'object') throw new Error('账号格式错误');
    const previous = input.key ? resolveAccounts(DATA, accountOptions).accounts.find((a) => a.key === input.key) : null;
    const location = String(input.location ?? previous?.location ?? '').trim();
    if (location && !watcher.locations.resolve(location)) throw new Error('账号签到位置未识别，请选择列表点位或填写经度,纬度');
    if (config.load().autoAnswer && input.enabled !== false && (input.autoAnswer === undefined ? previous?.autoAnswer !== false : input.autoAnswer === true) && !watcher.locations.resolve(location || config.load().autoDefaultLocation)) throw new Error('自动签到已开启，请先为该账号设置签到位置');
    const result = saveAccount(DATA, input, accountOptions);
    watcher.sessions.delete(result.key); watcher.accountStates.delete(result.key);
    watcher.changed(); watcher.log('success', '账号已保存到本地 accounts.env');
    if (!SELF_TEST) watcher.checkOnce().catch((error) => watcher.log('error', error.message));
    return { ok: true, key: result.key };
  });
  handle('delete-account', (key) => {
    const result = deleteAccount(DATA, key, accountOptions);
    watcher.sessions.delete(result.key); watcher.accountStates.delete(result.key);
    if (result.remaining === 0) { watcher.lastActiveRollcalls = []; watcher.lastError = ''; }
    watcher.changed(); watcher.log('info', '账号已从本地 accounts.env 移除');
    return { ok: true, key: result.key, remaining: result.remaining };
  });
  ipcMain.handle('open-external', (_event, url) => openExternal(url));
}

watcher.on('status', (status) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status-update', status);
  refreshTray();
});
watcher.on('log', (entry) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('log-entry', entry); });

app.on('second-instance', (_event, argv) => {
  if (argv.includes('--quit')) return app.quit();
  if (argv.includes('--enable-autostart')) setAutostart(true);
  if (argv.includes('--disable-autostart')) setAutostart(false);
  refreshTray();
  if (!argv.includes('--background')) showMain();
});
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
  watcher.stop();
  if (testConfigSnapshot) config.patch(testConfigSnapshot);
});
app.on('quit', () => {
  if (tempSelfTestDir) {
    try { rmSync(tempSelfTestDir, { recursive: true, force: true }); } catch { /* 忽略临时目录清理错误 */ }
  }
});
process.on('uncaughtException', (error) => { report.errors.push(error.stack); watcher.log('error', error.message); });
process.on('unhandledRejection', (error) => { report.errors.push(String(error?.stack || error)); watcher.log('error', String(error?.message || error)); });

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'light';
  registerIpc();
  if (process.argv.includes('--enable-autostart')) setAutostart(true);
  if (process.argv.includes('--disable-autostart')) setAutostart(false);
  tray = new Tray(appIcon(32));
  tray.on('click', showMain); tray.on('double-click', showMain);
  refreshTray();
  await createMain();
  powerMonitor.on('resume', () => { if (watcher.running) { watcher.accountStates.clear(); watcher.checkOnce().catch(() => {}); } });
  if (!SELF_TEST) watcher.start();
  if (SELF_TEST) { const { runSelfTest } = await import('./self-test.js'); await runSelfTest({ app, mainWindow, tray, watcher, popups, testPopup, showMain, report, ROOT, DATA }); }
}).catch((error) => {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, 'startup-error.txt'), error.stack || String(error));
  app.quit();
});
