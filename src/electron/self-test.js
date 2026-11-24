// 仅 --self-test 启用，在实际 Electron 窗口内验证预载、IPC、账号 .env 持久化、布局与托盘链路。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountsFile, parseEnvFile } from '../accounts.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSelfTest({ app, mainWindow, tray, watcher, popups, testPopup, report, DATA }) {
  const out = process.env.ROLLCALL_TEST_OUTPUT || join(tmpdir(), 'rollcall-self-test-report');
  mkdirSync(out, { recursive: true });
  const assert = (name, condition, details) => {
    report.assertions.push({ name, pass: Boolean(condition), ...(details === undefined ? {} : { details }) });
  };
  const js = (expression) => mainWindow.webContents.executeJavaScript(expression, true);
  try {
    await delay(400);
    assert('main_visible', mainWindow.isVisible());
    assert('native_tray_created', tray && !tray.isDestroyed());
    assert('preload_bridge', await js("typeof window.electronAPI?.getStatus === 'function' && typeof window.electronAPI?.deleteAccount === 'function' && typeof window.electronAPI?.openEnvFile === 'function'"));
    assert('interface_connected', await js("document.getElementById('ipcError').hidden"));

    // 初始无账号时，首页展示「添加账号」快捷入口，点击直达添加表单并持久化到本地 accounts.env。
    assert('hero_add_account_visible_when_empty', await js("!document.getElementById('btnHeroAddAccount').hidden"));
    await js("document.getElementById('btnHeroAddAccount').click()");
    await delay(150);
    assert('quick_add_opens_account_form', await js("!document.getElementById('tab-accounts').hidden && !document.getElementById('accountForm').hidden"));

    const savedAcc = await js(`window.electronAPI.saveAccount({ label: '本地测试账号', username: '202600000001', password: 'fixture#pass=1"2', location: 'zjg-dong1', enabled: true, autoAnswer: true })`);
    assert('save_account_to_env_ipc', savedAcc?.ok === true && savedAcc?.key === 'main');
    const envPath = accountsFile(DATA);
    const parsedEnv = existsSync(envPath) ? parseEnvFile(envPath) : {};
    assert('accounts_env_written_locally', parsedEnv.ZJU_USER === '202600000001' && parsedEnv.ZJU_PASSWORD === 'fixture#pass=1"2' && parsedEnv.ZJU_LABEL === '本地测试账号' && parsedEnv.ZJU_LOCATION === 'zjg-dong1');
    await delay(150);
    assert('hero_add_account_hidden_after_add', await js("document.getElementById('btnHeroAddAccount').hidden"));

    const removed = await js(`window.electronAPI.deleteAccount('main')`);
    assert('delete_account_from_env_ipc', removed?.ok === true && removed?.remaining === 0);
    const parsedAfterDelete = parseEnvFile(envPath);
    assert('accounts_env_cleared_after_delete', !parsedAfterDelete.ZJU_USER && !parsedAfterDelete.ZJU_PASSWORD);

    for (const tab of ['settings', 'accounts', 'logs', 'overview']) {
      await js(`document.getElementById('nav-${tab}').click()`);
      assert(`tab_${tab}`, await js(`!document.getElementById('tab-${tab}').hidden`));
    }

    const before = watcher.running;
    await js('window.electronAPI.toggleWatch()');
    assert('toggle_watch_via_ipc', watcher.running !== before);
    await js('window.electronAPI.toggleWatch()');
    assert('toggle_watch_restored', watcher.running === before);

    mainWindow.setSize(840, 600);
    await delay(200);
    assert('minimum_layout_no_horizontal_overflow', await js('document.documentElement.scrollWidth <= innerWidth'));
    mainWindow.setSize(1040, 720);

    const originalAutostart = await js('window.electronAPI.getAutostart()');
    const changedAutostart = await js(`window.electronAPI.setAutostart(${!originalAutostart})`);
    assert('autostart_registry_readback', changedAutostart === !originalAutostart);
    const restoredAutostart = await js(`window.electronAPI.setAutostart(${originalAutostart})`);
    assert('autostart_restored', restoredAutostart === originalAutostart);

    const setting = watcher.getStatus();
    const c = await js(`window.electronAPI.updateConfig({intervalMs:${setting.intervalMs === 30000 ? 60000 : 30000}})`);
    assert('config_ipc_saved', c.intervalMs !== setting.intervalMs);
    await js(`window.electronAPI.updateConfig({intervalMs:${setting.intervalMs}})`);

    watcher.running = true;
    await js("document.getElementById('btnWinClose').click()");
    await delay(200);
    assert('close_to_tray_preserves_listener', !mainWindow.isVisible() && watcher.running && !tray.isDestroyed());
    tray.emit('click');
    assert('tray_restore_main', mainWindow.isVisible());
    watcher.running = false;

    const previousCount = popups.length;
    await js("document.getElementById('btnTestPopup').click()");
    for (let i = 0; i < 60 && popups.length <= previousCount; i++) await delay(100);
    const popup = popups.at(-1)?.win;
    if (!popup) throw new Error('测试通知没有生成窗口');
    for (let i = 0; i < 60 && !popup.isVisible(); i++) await delay(100);
    const pjs = (source) => popup.webContents.executeJavaScript(source, true);
    await delay(350);
    assert('popup_visible', popup.isVisible());
    assert('popup_payload_not_lost', await pjs("document.getElementById('courseTitle').textContent.includes('测试')"));
    assert('popup_test_clearly_labelled', await pjs("document.getElementById('typeName').textContent.includes('非真实签到')"));
    assert('popup_persistent_zero_seconds', await pjs("document.getElementById('timerLabel').textContent.includes('手动关闭')"));
    assert('popup_content_fits', await pjs("document.getElementById('card').getBoundingClientRect().bottom <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth"));
    report.popupBounds = popup.getBounds();
    await pjs("document.getElementById('btnMain').click()");
    await delay(250);
    assert('popup_button_restores_main_and_closes', popup.isDestroyed() && mainWindow.isVisible());

    await testPopup();
    const timed = popups.at(-1).win;
    timed.webContents.send('show-popup', { test: true, title: '计时测试', seconds: 2, sound: false });
    await delay(200);
    await timed.webContents.executeJavaScript("document.getElementById('card').dispatchEvent(new MouseEvent('mouseenter'))");
    await delay(2300);
    assert('popup_hover_pauses_timer', !timed.isDestroyed() && timed.isVisible());
    await timed.webContents.executeJavaScript("document.getElementById('card').dispatchEvent(new MouseEvent('mouseleave')); document.activeElement.blur()");
    await delay(2400);
    assert('popup_timer_auto_closes', timed.isDestroyed());

    const { testAutomaticDesktop } = await import('./self-test-auto.js');
    await testAutomaticDesktop({ mainWindow, watcher, popups, out, assert });

    // 确认最终没有残留真实凭据文件
    assert('env_file_exists_cleanly', existsSync(envPath) && !readFileSync(envPath, 'utf8').includes('fixture#pass'));
    assert('no_runtime_errors', report.errors.length === 0, report.errors);
  } catch (error) {
    report.errors.push(error.stack || String(error));
  }
  report.passed = report.errors.length === 0 && report.assertions.every((item) => item.pass);
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  app.quit();
}
