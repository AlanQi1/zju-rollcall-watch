// 实际桌面 IPC/控件 + 完全隔离的模拟签到客户端，绝不向学校发出 PUT。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AutoSigner } from '../auto-sign.js';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function testAutomaticDesktop({ mainWindow, watcher, popups, out, assert }) {
  const js = (source) => mainWindow.webContents.executeJavaScript(source, true);
  const savedConfig = watcher.configStore.load();
  const wasRunning = watcher.running;
  watcher.stop();
  if (watcher.pending) await watcher.pending;
  const keys = ['accountProvider', 'login', 'clientFactory', 'sessions', 'accountStates', 'autoSigner', 'stateFile', 'seen', 'lastActiveRollcalls', 'logs', 'lastError', 'lastSuccessAt', 'lastCheckAt'];
  const saved = Object.fromEntries(keys.map((key) => [key, watcher[key]]));
  const fixture = join(out, 'auto-fixtures', randomUUID());
  mkdirSync(fixture, { recursive: true });
  const account = { key: 'main', label: '桌面模拟账号', username: '202600000001', password: 'fixture-only-not-real', enabled: true, autoAnswer: true, location: '' };
  const rollcall = { id: 'desktop-mock-only', courseTitle: '自动签到链路测试（本地模拟）', teacher: '测试客户端，无真实提交', type: '雷达点名', isRadar: true, active: true, handled: false, expired: false, url: 'https://courses.zju.edu.cn/user/index' };
  let submitted = 0;
  const client = { rollcalls: async () => [{ ...rollcall, active: submitted === 0, handled: submitted > 0, myStatus: submitted ? 'on_call_fine' : 'absent' }], answerRadar: async () => { submitted++; return { status: 200, json: { status: 'on_call_fine' } }; } };
  try {
    for (const popup of [...popups]) if (!popup.win.isDestroyed()) popup.win.close();
    watcher.accountProvider = () => ({ source: '本地桌面测试夹具', accounts: [account] });
    watcher.login = async () => ({ jar: {} });
    watcher.clientFactory = () => client;
    watcher.sessions = new Map(); watcher.accountStates = new Map(); watcher.seen = new Map(); watcher.logs = [];
    watcher.lastActiveRollcalls = []; watcher.lastError = '';
    watcher.stateFile = join(fixture, 'reminded.json');
    watcher.autoSigner = new AutoSigner(fixture, { getConfig: () => watcher.configStore.load(), locations: watcher.locations, log: (level, text) => watcher.log(level, text), changed: () => watcher.changed() });
    watcher.configStore.patch({ autoAnswer: false, autoFallback: false, notify: true, notifySound: false, notifySeconds: 0 });
    watcher.changed();
    await delay(150);

    // 预演场景 A：仅提醒模式下发现正在进行的点名（不提交签到），触发主界面高亮卡片与右下角弹窗。
    if (process.env.ROLLCALL_CAPTURE_REHEARSAL === '1') {
      watcher.running = true;
      await watcher.checkOnce();
      await delay(350);
      await js("document.getElementById('nav-overview').click()");
      await delay(200);
      writeFileSync(join(out, 'rehearse-1-active-dashboard.png'), (await mainWindow.webContents.capturePage()).toPNG());
      const alertPopup = popups.at(-1)?.win;
      if (alertPopup && !alertPopup.isDestroyed()) {
        await delay(300);
        writeFileSync(join(out, 'rehearse-2-active-popup.png'), (await alertPopup.webContents.capturePage()).toPNG());
        alertPopup.close();
      }
      watcher.running = false;
      watcher.seen = new Map();
      await delay(150);
    }

    await js("document.getElementById('nav-settings').click()");
    const locations = await js('window.electronAPI.getLocations()');
    assert('auto_location_ipc', Array.isArray(locations) && locations.length >= 12);
    const point = locations[0].id;
    await js(`(() => { const field = document.getElementById('setAutoDefaultLocation'); field.value = ${JSON.stringify(point)}; field.dispatchEvent(new Event('input', {bubbles:true})); field.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    for (let i = 0; i < 40 && watcher.configStore.load().autoDefaultLocation !== point; i++) await delay(50);
    assert('auto_location_saved_from_ui', watcher.configStore.load().autoDefaultLocation === point);
    await delay(180);
    await js("document.getElementById('setAutoAnswer').click()");
    for (let i = 0; i < 40 && !watcher.configStore.load().autoAnswer; i++) await delay(50);
    assert('auto_switch_saved_from_ui', watcher.configStore.load().autoAnswer === true);
    assert('auto_switch_alone_does_not_submit', submitted === 0);
    await delay(200);
    await js("document.activeElement.blur(); document.getElementById('autoSettingsTitle').scrollIntoView({block:'start'})");
    await delay(250);
    writeFileSync(join(out, 'auto-settings.png'), (await mainWindow.webContents.capturePage()).toPNG());
    // 不开启定时器，只在本次测试里标记监听状态，下一次查询由按钮显式触发。
    watcher.running = true; watcher.changed();
    await js("document.getElementById('nav-overview').click(); document.getElementById('btnCheckNow').click()");
    for (let i = 0; i < 100 && (!submitted || watcher.pending); i++) await delay(100);
    assert('auto_button_runs_mock_submit_once', submitted === 1);
    assert('auto_result_confirmed_in_history', watcher.getStatus().autoHistory.some((record) => record.rollcallId === rollcall.id && record.state === 'success'));
    assert('auto_success_removed_from_pending', watcher.getStatus().activeRollcalls.length === 0);
    await delay(250);
    assert('auto_result_visible_in_ui', await js("document.getElementById('autoHistoryList').textContent.includes('本地模拟') && document.getElementById('autoHistoryList').textContent.includes('成功')"));
    await js("document.getElementById('autoHistoryList').scrollIntoView({block:'center'})");
    await delay(250);
    writeFileSync(join(out, 'auto-result.png'), (await mainWindow.webContents.capturePage()).toPNG());
    const popup = popups.at(-1)?.win;
    assert('auto_success_creates_popup', popup && !popup.isDestroyed());
    if (popup && !popup.isDestroyed()) {
      await delay(350);
      assert('auto_success_popup_label', await popup.webContents.executeJavaScript("document.getElementById('typeName').textContent.includes('自动签到成功') && document.getElementById('courseTitle').textContent.includes('本地模拟')"));
      writeFileSync(join(out, 'auto-popup.png'), (await popup.webContents.capturePage()).toPNG());
      popup.close();
    }
    await watcher.checkOnce();
    assert('auto_recheck_does_not_repeat_submit', submitted === 1);
    await js("document.getElementById('nav-accounts').click(); document.querySelector('#accountsListWrap .btn').click()");
    assert('auto_account_controls_present', await js("!document.getElementById('accountForm').hidden && document.getElementById('accountAutoAnswer').checked && document.getElementById('accountLocation') !== null"));
    if (process.env.ROLLCALL_CAPTURE_REHEARSAL === '1') {
      await delay(250);
      writeFileSync(join(out, 'rehearse-5-accounts.png'), (await mainWindow.webContents.capturePage()).toPNG());
    }
    await js("document.getElementById('btnCancelAccount').click()");
  } finally {
    watcher.stop();
    if (watcher.pending) await watcher.pending;
    for (const popup of [...popups]) if (!popup.win.isDestroyed()) popup.win.close();
    Object.assign(watcher, saved);
    watcher.configStore.patch(savedConfig);
    watcher.changed();
    await js("document.getElementById('nav-overview').click(); document.getElementById('tab-overview').scrollTop = 0");
    if (wasRunning) watcher.start();
  }
}
