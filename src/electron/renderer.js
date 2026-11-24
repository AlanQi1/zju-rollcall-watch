'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const api = window.electronAPI;
  const $ = (id) => document.getElementById(id);
  const busy = new WeakSet();
  let currentStatus = null;
  let statusRequest = null;
  let toastTimer;
  let logs = [];
  let logRequest = null;
  let activeTab = 'tab-overview';
  let unsubscribeStatus;
  let unsubscribeLog;
  const dirtySettings = new Set();
  let locations = [];
  let locationRequest = null;
  let autoSettingError = '';

  // Status pushes update telemetry, never replace an in-progress settings draft.
  document.querySelectorAll('#tab-settings input, #tab-settings select').forEach((control) => {
    control.addEventListener('input', () => dirtySettings.add(control.id));
  });

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text ?? '');
    return node;
  }
  function icon(name) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.classList.add('icon');
    node.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    node.append(use);
    return node;
  }
  function messageOf(error) {
    return String(error?.message || error || '本地服务未返回结果').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
  function showError(error) {
    $('ipcErrorText').textContent = '连接或操作失败：' + messageOf(error);
    $('ipcError').hidden = false;
    $('footerStatus').textContent = '请查看上方错误并重试';
  }
  function toast(message, isError = false) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').classList.toggle('error', isError);
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, isError ? 6000 : 3200);
  }
  async function invoke(method, ...args) {
    if (!api || typeof api[method] !== 'function') throw new Error('桌面接口 ' + method + ' 尚未就绪，请重新启动 App');
    const result = await api[method](...args);
    if (result && typeof result === 'object' && result.ok === false) throw new Error(result.error || result.reason || result.message || '操作失败');
    return result;
  }
  async function action(control, work, loadingText) {
    if (busy.has(control)) return;
    busy.add(control);
    control.disabled = true;
    control.setAttribute('aria-busy', 'true');
    const label = control.querySelector('span:not(.slider)');
    const oldText = label ? label.textContent : null;
    if (loadingText && label) label.textContent = loadingText;
    try {
      return await work();
    } catch (error) {
      showError(error);
      toast(messageOf(error), true);
      return undefined;
    } finally {
      busy.delete(control);
      control.disabled = false;
      control.removeAttribute('aria-busy');
      if (loadingText && label) label.textContent = oldText;
      if (currentStatus) updateActionState();
    }
  }
  function timeValue(value) {
    if (!value) return NaN;
    if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
    return new Date(value).getTime();
  }
  function clock(value) {
    const time = timeValue(value);
    return Number.isFinite(time) ? new Date(time).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
  }
  function readableValue(value) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    if (typeof value === 'object') return value.message || value.label || value.name || JSON.stringify(value);
    return String(value);
  }
  function formatStarted(value) {
    if (!value) return '发起时间未知';
    return Number.isFinite(timeValue(value)) ? clock(value) + ' 发起' : readableValue(value);
  }
  const tabTitles = {
    'tab-overview': '监控台',
    'tab-settings': '偏好设置',
    'tab-accounts': '账号管理',
    'tab-logs': '运行日志',
  };
  function switchTab(target) {
    activeTab = target;
    if ($('pageTitle')) $('pageTitle').textContent = tabTitles[target] || '签到雷达';
    document.querySelectorAll('.nav-item').forEach((button) => {
      const selected = button.dataset.tab === target;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('.tab-pane').forEach((pane) => { pane.hidden = pane.id !== target; });
    if (target === 'tab-logs') refreshLogs().catch(showError);
  }
  const navButtons = [...document.querySelectorAll('.nav-item')];
  navButtons.forEach((button, index) => {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
    button.addEventListener('keydown', (event) => {
      let next = index;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % navButtons.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + navButtons.length - 1) % navButtons.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = navButtons.length - 1;
      else return;
      event.preventDefault();
      switchTab(navButtons[next].dataset.tab);
      navButtons[next].focus();
    });
  });
  for (const [id, method] of [['btnWinMin', 'minimize'], ['btnWinMax', 'maximize'], ['btnWinClose', 'close']]) {
    $(id).addEventListener('click', () => action($(id), () => invoke(method)));
  }
  $('btnManageAccounts').addEventListener('click', () => switchTab('tab-accounts'));
  function openQuickAddAccount() {
    switchTab('tab-accounts');
    openAccountForm(null);
  }
  $('btnHeroAddAccount').addEventListener('click', openQuickAddAccount);
  $('btnQuickAddAccount').addEventListener('click', openQuickAddAccount);

  async function refreshStatus() {
    if (statusRequest) return statusRequest;
    statusRequest = (async () => {
      const data = await invoke('getStatus');
      if (!data || typeof data !== 'object') throw new Error('状态数据为空，请重新连接');
      renderStatus(data);
      return data;
    })();
    try { return await statusRequest; } finally { statusRequest = null; }
  }
  function updateActionState() {
    const checking = !!currentStatus?.checking;
    if (!busy.has($('btnCheckNow'))) {
      $('btnCheckNow').disabled = checking;
      $('checkLabel').textContent = checking ? '正在检查…' : '立即检查';
    }
    if (!busy.has($('btnToggleWatch'))) {
      $('toggleLabel').textContent = currentStatus?.running ? '暂停监听' : '开始监听';
      $('toggleIcon').setAttribute('href', currentStatus?.running ? '#i-pause' : '#i-play');
    }
  }
  function updateCountdown() {
    if (!currentStatus) return;
    const target = timeValue(currentStatus.nextCheckAt);
    let label = '—';
    if (currentStatus.checking) label = '检查中';
    else if (!currentStatus.running) label = '已暂停';
    else if (Number.isFinite(target)) {
      const seconds = Math.max(0, Math.ceil((target - Date.now()) / 1000));
      label = seconds === 0 ? '即将' : String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
    }
    $('nextCountdown').textContent = label;
    if ($('sideCountdown')) $('sideCountdown').textContent = label;
  }
  function syncSetting(id, value, checkbox = false) {
    const control = $(id);
    if (busy.has(control) || dirtySettings.has(id) || document.activeElement === control) return;
    if (checkbox) control.checked = !!value;
    else {
      const string = String(value ?? '');
      if (control.tagName === 'SELECT' && ![...control.options].some((option) => option.value === string) && string) {
        const option = element('option', '', Number(string) / (id === 'setIntervalSelect' ? 1000 : 1) + ' 秒 · 当前');
        option.value = string;
        control.append(option);
      }
      control.value = string;
    }
  }
  function renderStatus(data) {
    currentStatus = { ...data, accounts: Array.isArray(data.accounts) ? data.accounts : [], activeRollcalls: Array.isArray(data.activeRollcalls) ? data.activeRollcalls : [], autoHistory: Array.isArray(data.autoHistory) ? data.autoHistory : [] };
    const status = currentStatus;
    const hasError = !!status.lastError;
    const stateClass = hasError ? 'is-error' : status.running ? 'is-running' : 'is-paused';
    const stateText = status.checking ? '正在检查' : hasError ? '需要留意' : status.running ? '监听中' : '已暂停';
    $('topStatusPill').className = 'status-pill ' + stateClass;
    $('topStatusText').textContent = stateText;
    if ($('sideStatusDot')) $('sideStatusDot').className = 'status-dot ' + stateClass;
    if ($('sideStatusText')) $('sideStatusText').textContent = stateText;
    if ($('sideLiveSub')) $('sideLiveSub').textContent = status.activeRollcalls.length ? `发现 ${status.activeRollcalls.length} 项待处理签到` : (status.accounts.length ? `已监听 ${status.accounts.length} 个账号` : '尚未配置账号');
    $('heroCard').classList.toggle('is-running', !!status.running);
    $('heroBadge').textContent = status.checking ? '正在同步各账号的签到状态' : hasError ? '最近一轮检查出现异常' : status.running ? '后台监听运行中' : '后台监听已暂停';
    $('heroTitle').textContent = status.activeRollcalls.length ? `发现 ${status.activeRollcalls.length} 项正在进行的签到` : status.checking ? '正在检查最新课堂点名…' : hasError ? '账号会话需要留意' : status.running ? '签到监控正常运行中' : '监听已暂停，可随时恢复';
    const mode = status.autoSigning === true ? '自动签到执行中' : status.autoAnswer === true ? '自动签到已开启' : '仅提醒模式';
    $('autoModeStatus').textContent = mode;
    $('autoModeStatus').className = 'mode-chip ' + (status.autoSigning === true ? 'is-paused' : status.autoAnswer === true ? 'is-running' : '');
    $('autoSettingsStatus').textContent = mode;
    $('autoSettingsStatus').className = 'mode-chip ' + (status.autoSigning === true ? 'is-paused' : status.autoAnswer === true ? 'is-running' : '');
    $('footerMode').textContent = mode;
    $('settingsModeNote').textContent = (status.autoAnswer === true ? '雷达点名自动签到已开启；数字点名与二维码签到仅提醒。' : '当前只检查并提醒；自动签到总开关关闭。') + '账号密码仅保存在本机 accounts.env，直连学在浙大。';
    $('heroDescription').textContent = !status.accounts.length ? '先添加一个浙大账号（将保存在本地 accounts.env），即可开始接收签到提醒。' : (status.autoSigning === true ? '正在执行雷达点名自动签到，请等待读回结果。' : status.autoAnswer === true ? '按账号点位尝试雷达签到；数字与二维码签到请手动完成。' : '当前仅提醒不代签。如需雷达自动签到可在「偏好设置」中开启。') + (status.running ? ' 关闭窗口后仍在系统托盘继续监听。' : ' 自动监听已暂停，手动检查仍会应用当前配置。') + (status.notify === false ? ' 桌面弹窗已关闭。' : '');
    $('btnHeroAddAccount').hidden = status.accounts.length > 0;
    $('valInterval').textContent = Number.isFinite(Number(status.intervalMs)) ? '每 ' + Number(status.intervalMs) / 1000 + ' 秒检查' : '检查间隔未知';
    $('lastCheckTimeText').textContent = status.lastCheckAt ? '上次检查 ' + clock(status.lastCheckAt) : '尚未进行检查';
    $('lastSuccessText').textContent = status.lastSuccessAt ? '最近检查成功 ' + clock(status.lastSuccessAt) : '尚无成功检查记录';
    $('footerStatus').textContent = status.checking ? '正在与学在浙大同步' : status.running ? '后台监听中 · ' + status.accounts.length + ' 个账号' : '自动监听已暂停';
    $('activeBadge').textContent = status.activeRollcalls.length;
    $('accountBadge').textContent = status.accounts.length;
    if ($('navActiveBadge')) {
      $('navActiveBadge').textContent = status.activeRollcalls.length;
      $('navActiveBadge').hidden = status.activeRollcalls.length === 0;
    }
    if ($('navAccountBadge')) $('navAccountBadge').textContent = status.accounts.length;
    $('rollcallHint').textContent = status.checking ? '同步中' : hasError ? '最近检查异常' : status.lastSuccessAt ? '真实检查结果' : '等待首次成功检查';
    $('monitorError').textContent = status.lastError ? '最近异常：' + readableValue(status.lastError) : '';
    $('monitorError').hidden = !hasError;
    syncSetting('setNotify', status.notify, true);
    syncSetting('setNotifySound', status.notifySound, true);
    syncSetting('setIntervalSelect', status.intervalMs);
    syncSetting('setNotifySeconds', status.notifySeconds ?? 0);
    syncSetting('setAutoAnswer', status.autoAnswer === true, true);
    syncSetting('setAutoDefaultLocation', status.autoDefaultLocation || '');
    syncSetting('setAutoFallback', status.autoFallback === true, true);
    renderLocationWarning();
    renderAutoHistory(status.autoHistory);
    renderRollcalls(status.activeRollcalls);
    renderAccounts(status.accounts, status.credentialSource);
    updateActionState();
    updateCountdown();
  }
  function emptyState(container, title, description, glyph = 'radar') {
    const empty = element('div', 'empty-state');
    const mark = element('span', 'empty-icon');
    mark.append(icon(glyph));
    empty.append(mark, element('h3', '', title), element('p', '', description));
    container.replaceChildren(empty);
  }
  function autoState(state) {
    const states = {
      success: { text: '成功', className: 'success' },
      failed: { text: '失败', className: 'failed' },
      pending: { text: '待确认', className: 'pending' },
      skipped: { text: '已跳过', className: 'skipped' },
    };
    return Object.hasOwn(states, state) ? states[state] : { text: '待确认', className: 'pending' };
  }
  function historyTime(value) {
    const time = timeValue(value);
    return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '时间未知';
  }
  function renderAutoHistory(items) {
    const list = $('autoHistoryList');
    if (!items.length) {
      emptyState(list, '暂无自动签到记录', currentStatus.autoAnswer === true ? '执行结果将在此显示，未收到确认前不会标记为成功。' : '自动签到默认关闭。仅开启并执行后才会产生记录。', 'clock');
      return;
    }
    const fragment = document.createDocumentFragment();
    [...items].sort((a, b) => (timeValue(b.updatedAt) || 0) - (timeValue(a.updatedAt) || 0)).slice(0, 15).forEach((item) => {
      const state = autoState(item.state);
      const row = element('div', 'auto-history-row');
      row.setAttribute('role', 'listitem');
      const heading = element('div', 'auto-history-heading');
      heading.append(element('h3', '', item.courseTitle || '未命名课程'), element('span', 'auto-result ' + state.className, state.text));
      const reason = readableValue(item.message) || (item.state === 'success' ? '后端已确认签到成功' : item.state === 'failed' ? '后端返回失败，请查看日志或课程平台。' : item.state === 'skipped' ? '本次未执行签到' : '尚未收到成功确认，请到课程平台核实。');
      const metadata = ['账号 ' + readableValue(item.accountLabel || item.accountKey || '未知'), historyTime(item.updatedAt), item.locationName ? '点位 ' + readableValue(item.locationName) : '', Number.isFinite(Number(item.attempts)) ? '尝试 ' + Number(item.attempts) + ' 次' : ''].filter(Boolean);
      row.append(heading, element('p', 'rollcall-meta', metadata.join(' · ')), element('p', 'auto-history-reason', reason));
      fragment.append(row);
    });
    list.replaceChildren(fragment);
  }
  function locationLabel(value) {
    const found = locations.find((item) => String(item.id) === value || item.name === value);
    return found ? found.name + (found.campus ? ' · ' + found.campus : '') : value;
  }
  function locationError(value) {
    if (!value || !/[,，]/.test(value)) return '';
    const parts = value.split(/[,，]/).map((part) => part.trim());
    if (parts.length !== 2 || parts.some((part) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(part)) || Math.abs(Number(parts[0])) > 180 || Math.abs(Number(parts[1])) > 90) return '点位格式有误：请输入 经度,纬度（经度 -180～180，纬度 -90～90）。';
    return '';
  }
  function renderLocationWarning() {
    const enabled = $('setAutoAnswer').checked;
    const value = $('setAutoDefaultLocation').value.trim();
    const invalid = locationError(value);
    const missing = (currentStatus?.accounts || []).filter((account) => account.enabled !== false && account.autoAnswer !== false && !String(account.location || value).trim());
    const message = autoSettingError || invalid || (enabled && missing.length ? '缺少签到点位：' + missing.map((account) => account.label || account.key).join('、') + '。请填写全局默认点位或对应账号点位；缺少位置时不会显示签到成功。' : '');
    $('autoLocationError').textContent = message;
    $('autoLocationError').hidden = !message;
    $('setAutoDefaultLocation').setAttribute('aria-invalid', String(!!invalid));
    const persistedMissing = (currentStatus?.accounts || []).filter((account) => account.enabled !== false && account.autoAnswer !== false && !String(account.location || currentStatus?.autoDefaultLocation || '').trim());
    const overviewMessage = currentStatus?.autoAnswer === true && persistedMissing.length ? '自动签到缺少点位：' + persistedMissing.map((account) => account.label || account.key).join('、') + '。请到设置或账号页补充位置。' : '';
    $('autoOverviewError').textContent = overviewMessage;
    $('autoOverviewError').hidden = !overviewMessage;
  }
  async function refreshLocations() {
    if (locationRequest) return locationRequest;
    locationRequest = (async () => {
      try {
        const result = await invoke('getLocations');
        if (!Array.isArray(result)) throw new Error('点位列表格式异常');
        locations = result;
        const fragment = document.createDocumentFragment();
        locations.forEach((item) => {
          const option = element('option', '', [item.campus, item.lon + ',' + item.lat].filter(Boolean).join(' · '));
          option.value = String(item.id);
          option.label = String(item.name || item.id) + (item.campus ? ' · ' + item.campus : '');
          fragment.append(option);
        });
        $('locationOptions').replaceChildren(fragment);
        $('locationLoadError').hidden = true;
        if (currentStatus) renderAccounts(currentStatus.accounts, currentStatus.credentialSource);
      } catch (error) {
        $('locationLoadError').textContent = '预置点位加载失败：' + messageOf(error) + '。可手动输入点位或经度,纬度，点击「重新连接」重试。';
        $('locationLoadError').hidden = false;
        throw error;
      }
    })();
    try { await locationRequest; } finally { locationRequest = null; }
  }
  function renderRollcalls(items) {
    const container = $('rollcallContainer');
    if (!items.length) {
      const neverSucceeded = !currentStatus.lastSuccessAt;
      const failed = !!currentStatus.lastError;
      emptyState(container, failed ? '检查出现异常，暂未发现签到' : neverSucceeded ? '等待首次检查结果' : '当前没有进行中的签到', failed ? '这不代表没有签到，请查看账号状态或立即重试。' : neverSucceeded ? '完成一次成功检查后，这里会显示实时签到。' : currentStatus.running ? '有新签到时，会在这里显示并发送提醒。' : '自动监听已暂停，你可以点击「立即检查」。');
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const card = element('div', 'rollcall-item');
      const body = element('div', 'rollcall-item-body');
      const heading = element('div', 'rollcall-item-heading');
      heading.append(element('span', 'rollcall-type', item.type || '签到'), element('h3', '', item.courseTitle || item.title || '未命名课程'));
      body.append(heading, element('p', 'rollcall-meta', [item.teacher ? '教师 ' + readableValue(item.teacher) : '', '账号 ' + readableValue(item.accountLabel || item.account || item.accountKey || '未知'), formatStarted(item.startedAt)].filter(Boolean).join(' · ')));
      if (item.autoState || item.autoMessage) {
        const state = autoState(item.autoState);
        body.append(element('p', 'auto-rollcall-state ' + state.className, '自动签到：' + state.text + (item.autoMessage ? ' · ' + readableValue(item.autoMessage) : '')));
      }
      card.append(body);
      if (item.url) {
        const open = element('button', 'btn btn-primary', '打开课程平台');
        open.append(icon('arrow'));
        open.addEventListener('click', () => action(open, () => invoke('openExternal', String(item.url))));
        card.append(open);
      }
      fragment.append(card);
    }
    container.replaceChildren(fragment);
  }
  function accountState(account) {
    if (account.enabled === false) return { text: '已停用', className: '' };
    if (account.error) return { text: '连接异常', className: 'error' };
    if (account.sessionActive) return { text: '会话有效', className: 'ok' };
    return { text: '等待验证', className: '' };
  }
  function identity(account, index) {
    const group = element('div', 'session-identity');
    const copy = element('div', 'account-details');
    copy.append(element('div', 'account-name', account.label || account.key || '账号 ' + (index + 1)), element('div', 'account-username', account.username ? '学号 ' + account.username : '学号未配置'));
    group.append(element('span', 'account-avatar', String(index + 1).padStart(2, '0')), copy);
    return group;
  }
  function renderAccounts(accounts, source) {
    const envPath = readableValue(source || currentStatus?.accountsEnvFile);
    $('credSourceBadge').textContent = source ? '来源：' + readableValue(source) : '将保存至：' + (envPath || '本地 accounts.env');
    $('credSourceBadge').title = envPath || '';
    const summary = $('sessionSummary');
    const list = $('accountsListWrap');
    if (!accounts.length) {
      emptyState(summary, '还没有账号', '点击上方「添加账号」，填写学号与密码并保存到本地 accounts.env。', 'users');
      emptyState(list, '连接你的第一个账号', '点击右上角「添加账号」，学号和密码将保存在本地 accounts.env。', 'users');
      return;
    }
    const smallFragment = document.createDocumentFragment();
    const listFragment = document.createDocumentFragment();
    accounts.forEach((account, index) => {
      const state = accountState(account);
      const row = element('div', 'session-row');
      const summaryIdentity = identity(account, index);
      if (account.error) summaryIdentity.querySelector('.account-details').append(element('p', 'session-error', readableValue(account.error)));
      row.append(summaryIdentity, element('span', 'session-state ' + state.className, state.text));
      smallFragment.append(row);
      const card = element('div', 'account-item');
      const details = element('div', 'account-details');
      details.append(identity(account, index));
      const metadata = element('div', 'account-detail-line');
      metadata.append(element('span', 'session-state ' + state.className, state.text), element('span', '', account.lastSuccessAt ? '最近检查成功 ' + clock(account.lastSuccessAt) : '尚无成功检查记录'));
      details.append(metadata);
      const participating = account.autoAnswer !== false;
      details.append(element('p', 'account-auto-detail', (participating ? '参与自动签到' : '仅提醒，不参与自动签到') + (currentStatus?.autoAnswer === true ? '' : ' · 总开关关闭') + ' · 点位：' + (account.location ? locationLabel(String(account.location)) : currentStatus?.autoDefaultLocation ? '使用全局 · ' + locationLabel(String(currentStatus.autoDefaultLocation)) : '未配置')));
      if (account.error) details.append(element('p', 'account-error', readableValue(account.error)));
      const actions = element('div', 'account-actions');
      const edit = element('button', 'btn btn-secondary', '编辑账号');
      edit.addEventListener('click', () => openAccountForm(account));
      const remove = element('button', 'btn btn-secondary btn-danger', '删除');
      let confirmResetTimer;
      remove.addEventListener('click', () => {
        if (remove.dataset.armed !== '1') {
          remove.dataset.armed = '1';
          remove.textContent = '确认删除';
          clearTimeout(confirmResetTimer);
          confirmResetTimer = setTimeout(() => {
            remove.dataset.armed = '';
            remove.textContent = '删除';
          }, 4000);
          return;
        }
        clearTimeout(confirmResetTimer);
        action(remove, async () => {
          await invoke('deleteAccount', account.key);
          if ($('accountKey').value === account.key) {
            $('accountForm').hidden = true;
            $('accountPassword').value = '';
          }
          await refreshStatus();
          toast('账号已从本地 accounts.env 移除');
        });
      });
      actions.append(edit, remove);
      card.append(details, actions);
      listFragment.append(card);
    });
    summary.replaceChildren(smallFragment);
    list.replaceChildren(listFragment);
  }
  $('btnCheckNow').addEventListener('click', () => action($('btnCheckNow'), async () => {
    await invoke('checkNow');
    const status = await refreshStatus();
    toast(status.lastError ? '检查完成，但有账号出现异常，请查看会话状态。' : '检查完成，已更新当前签到。', !!status.lastError);
  }, '正在检查…'));
  $('btnToggleWatch').addEventListener('click', () => action($('btnToggleWatch'), async () => {
    await invoke('toggleWatch');
    const status = await refreshStatus();
    toast(status.running ? '已开始后台监听' : '已暂停自动监听');
  }, '正在切换…'));
  $('btnTestPopup').addEventListener('click', () => action($('btnTestPopup'), async () => {
    await invoke('testPopup');
    toast('测试提醒已发送。这是一条测试，不是真实签到。');
  }));

  for (const [id, key, checkbox] of [['setNotify', 'notify', true], ['setNotifySound', 'notifySound', true], ['setIntervalSelect', 'intervalMs', false], ['setNotifySeconds', 'notifySeconds', false]]) {
    const control = $(id);
    control.addEventListener('change', () => action(control, async () => {
      const value = checkbox ? control.checked : Number(control.value);
      const previous = currentStatus?.[key];
      try {
        await invoke('updateConfig', { [key]: value });
        dirtySettings.delete(id);
        toast('设置已保存');
      } catch (error) {
        dirtySettings.delete(id);
        if (checkbox) control.checked = !!previous;
        else if (previous !== undefined) control.value = String(previous);
        throw error;
      } finally { await refreshStatus(); }
    }));
  }
  for (const [id, key, checkbox] of [['setAutoAnswer', 'autoAnswer', true], ['setAutoDefaultLocation', 'autoDefaultLocation', false], ['setAutoFallback', 'autoFallback', true]]) {
    const control = $(id);
    control.addEventListener('input', () => { autoSettingError = ''; renderLocationWarning(); });
    control.addEventListener('change', () => action(control, async () => {
      const value = checkbox ? control.checked : control.value.trim().replace('，', ',');
      const previous = currentStatus?.[key];
      autoSettingError = '';
      if (!checkbox && locationError(value)) {
        autoSettingError = locationError(value);
        $('autoSettingsFeedback').textContent = '点位尚未保存，请修正格式。';
        renderLocationWarning();
        return;
      }
      $('autoSettingsFeedback').textContent = '正在保存自动签到设置…';
      try {
        await invoke('updateConfig', { [key]: value });
        dirtySettings.delete(id);
        if (!checkbox) control.value = value;
        $('autoSettingsFeedback').textContent = '设置已保存。仅后端确认成功的签到才会显示成功。';
        toast('自动签到设置已保存');
      } catch (error) {
        if (checkbox) { control.checked = previous === true; dirtySettings.delete(id); }
        autoSettingError = '设置保存失败：' + messageOf(error);
        $('autoSettingsFeedback').textContent = '未保存，请检查错误后重试。';
        throw error;
      } finally {
        renderLocationWarning();
        await refreshStatus();
      }
    }));
  }
  async function refreshAutostart() {
    const result = await invoke('getAutostart');
    $('setAutostart').checked = typeof result === 'boolean' ? result : !!(result?.enabled ?? result?.openAtLogin);
  }
  $('setAutostart').addEventListener('change', () => action($('setAutostart'), async () => {
    try { await invoke('setAutostart', $('setAutostart').checked); toast('开机启动设置已保存'); }
    finally { dirtySettings.delete('setAutostart'); await refreshAutostart(); }
  }));
  $('btnRetry').addEventListener('click', () => action($('btnRetry'), async () => {
    await Promise.all([refreshStatus(), refreshAutostart(), refreshLocations()]);
    $('ipcError').hidden = true;
    toast('已重新连接本地服务');
  }));

  function openAccountForm(account) {
    const editing = !!account;
    $('accountForm').reset();
    $('accountKey').value = account?.key || '';
    $('accountLabel').value = account?.label || '';
    $('accountUsername').value = '';
    $('accountPassword').value = '';
    $('accountPassword').type = 'password';
    $('accountUsername').required = !editing;
    $('accountPassword').required = !editing;
    $('accountUsername').placeholder = editing ? '留空保留原学号（' + (account.username || '已配置') + '）' : '输入浙大学号';
    $('accountPassword').placeholder = editing ? '留空保留现有密码' : '输入 ZJUAM 密码';
    $('accountEnabled').checked = account?.enabled !== false;
    $('accountLocation').value = account?.location || '';
    $('accountLocation').setAttribute('aria-invalid', 'false');
    $('accountAutoAnswer').checked = account?.autoAnswer !== false;
    $('accountFormTitle').textContent = editing ? '编辑账号' : '添加账号';
    $('accountFormHint').textContent = (editing ? '学号和密码留空保留现有值。' : '学号和密码将写入本地 accounts.env 文件。') + '参与开关与点位可独立保存；仅总开关开启后执行雷达自动签到。';
    $('accountFormError').textContent = '';
    $('accountForm').hidden = false;
    $('accountForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('accountLabel').focus({ preventScroll: true });
  }
  $('btnNewAccount').addEventListener('click', () => openAccountForm(null));
  $('btnCancelAccount').addEventListener('click', () => { $('accountForm').hidden = true; $('accountPassword').value = ''; $('accountPassword').type = 'password'; });
  if ($('btnTogglePassword')) {
    $('btnTogglePassword').addEventListener('click', () => {
      const field = $('accountPassword');
      field.type = field.type === 'password' ? 'text' : 'password';
      field.focus();
    });
  }
  $('btnOpenEnvFile').addEventListener('click', () => action($('btnOpenEnvFile'), () => invoke('openEnvFile')));
  $('btnOpenAccounts').addEventListener('click', () => action($('btnOpenAccounts'), () => invoke('openAccounts')));
  $('accountForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!$('accountForm').reportValidity()) return;
    const invalidLocation = locationError($('accountLocation').value.trim());
    $('accountLocation').setAttribute('aria-invalid', String(!!invalidLocation));
    if (invalidLocation) {
      $('accountFormError').textContent = invalidLocation;
      $('accountLocation').focus();
      return;
    }
    action($('btnSaveAccount'), async () => {
      $('accountFormError').textContent = '';
      const payload = {
        ...($('accountKey').value ? { key: $('accountKey').value } : {}),
        label: $('accountLabel').value.trim(),
        username: $('accountUsername').value.trim(),
        password: $('accountPassword').value,
        enabled: $('accountEnabled').checked,
        location: $('accountLocation').value.trim().replace('，', ','),
        autoAnswer: $('accountAutoAnswer').checked,
      };
      try {
        await invoke('saveAccount', payload);
        $('accountPassword').value = '';
        $('accountForm').hidden = true;
        await refreshStatus();
        toast('账号已保存到本地 accounts.env。立即检查即可验证会话。');
      } catch (error) {
        $('accountFormError').textContent = messageOf(error);
        throw error;
      }
    });
  });

  function logNode(log) {
    const row = element('div', 'log-line');
    const level = String(log?.level || 'info').toLowerCase();
    const levelClass = ['info', 'warn', 'error', 'success'].includes(level) ? level : 'info';
    const rawTime = log?.time || log?.timestamp || log?.at;
    const time = Number.isFinite(timeValue(rawTime)) ? clock(rawTime) : readableValue(rawTime) || '—';
    row.append(element('time', 'log-time', time), element('span', 'log-level ' + levelClass, level.toUpperCase()), element('span', 'log-message', typeof log === 'string' ? log : readableValue(log?.message || log?.text || log)));
    return row;
  }
  function renderLogs() {
    const list = $('terminalBox');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 70;
    if (!logs.length) { list.replaceChildren(element('div', 'log-empty', '这里还很安静。检查记录会在运行后显示。')); return; }
    const fragment = document.createDocumentFragment();
    logs.slice(-300).forEach((log) => fragment.append(logNode(log)));
    list.replaceChildren(fragment);
    if (atBottom) list.scrollTop = list.scrollHeight;
  }
  async function refreshLogs() {
    if (logRequest) return logRequest;
    logRequest = (async () => {
      const result = await invoke('getLogs');
      logs = (Array.isArray(result) ? result : Array.isArray(result?.logs) ? result.logs : []).slice(-300);
      renderLogs();
    })();
    try { await logRequest; } finally { logRequest = null; }
  }
  $('btnClearLogs').addEventListener('click', () => { logs = []; renderLogs(); toast('已清空当前显示，历史日志仍保留在本地。'); });
  $('btnRefreshLogs').addEventListener('click', () => action($('btnRefreshLogs'), refreshLogs));
  window.addEventListener('error', (event) => showError(event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => { event.preventDefault(); showError(event.reason); });

  if (!api) {
    showError(new Error('桌面接口未加载。请从桌面 App 启动，而不是在普通浏览器中打开此页面。'));
    $('topStatusText').textContent = '连接未就绪';
    return;
  }
  try {
    if (typeof api.onStatusUpdate === 'function') unsubscribeStatus = api.onStatusUpdate((data) => { if (data && typeof data === 'object') renderStatus(data); });
    if (typeof api.onLogEntry === 'function') unsubscribeLog = api.onLogEntry((entry) => { logs.push(entry); logs = logs.slice(-300); renderLogs(); });
  } catch (error) { showError(error); }
  refreshStatus().catch(showError);
  refreshAutostart().catch(showError);
  refreshLocations().catch(showError);
  refreshLogs().catch(showError);
  const countdownTimer = setInterval(updateCountdown, 250);
  const fallbackTimer = setInterval(() => {
    refreshStatus().catch(showError);
    if (activeTab === 'tab-logs' && !unsubscribeLog) refreshLogs().catch(showError);
  }, 10000);
  window.addEventListener('beforeunload', () => {
    clearInterval(countdownTimer);
    clearInterval(fallbackTimer);
    clearTimeout(toastTimer);
    if (typeof unsubscribeStatus === 'function') unsubscribeStatus();
    if (typeof unsubscribeLog === 'function') unsubscribeLog();
  });
});
