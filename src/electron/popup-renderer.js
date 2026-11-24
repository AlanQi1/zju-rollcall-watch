'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const api = window.popupAPI;
  const $ = (id) => document.getElementById(id);
  const controls = ['btnClose', 'btnOpen', 'btnMain', 'btnDismiss'];
  let popupData = null;
  let timer = null;
  let durationMs = 0;
  let remainingMs = 0;
  let lastTick = 0;
  let hovered = false;
  let focusInside = false;
  let performing = false;
  let dismissed = false;
  let unsubShow;
  let audioContext;
  let audioCloseTimer;

  function messageOf(error) { return String(error?.message || error || '本地服务未返回结果'); }
  function errorVisible(error) {
    stopTimer();
    $('popupError').textContent = '操作失败：' + messageOf(error);
    $('popupError').hidden = false;
    $('card').classList.add('has-error');
    $('timerLabel').textContent = '操作未完成，请重试或关闭';
  }
  async function invoke(method, ...args) {
    if (!api || typeof api[method] !== 'function') throw new Error('桌面接口 ' + method + ' 尚未就绪');
    const result = await api[method](...args);
    if (result && typeof result === 'object' && result.ok === false) throw new Error(result.error || result.reason || result.message || '操作失败');
    return result;
  }
  function stopTimer() { clearInterval(timer); timer = null; }
  function isPaused() { return hovered || focusInside || performing; }
  function updateClock() {
    const now = performance.now();
    if (durationMs > 0 && !isPaused()) remainingMs = Math.max(0, remainingMs - Math.max(0, now - lastTick));
    lastTick = now;
    if (!durationMs) { $('timerLabel').textContent = '保留至手动关闭'; return; }
    $('progressBar').style.transform = 'scaleX(' + Math.max(0, remainingMs / durationMs) + ')';
    $('timerLabel').textContent = (isPaused() ? '已暂停 · ' : '') + Math.ceil(remainingMs / 1000) + ' 秒后关闭';
    if (remainingMs <= 0 && !performing && !dismissed) dismiss();
  }
  async function runAction(work) {
    if (performing || dismissed) return;
    updateClockBeforePause();
    performing = true;
    controls.forEach((id) => { $(id).disabled = true; });
    try {
      await work();
    } catch (error) {
      dismissed = false;
      errorVisible(error);
    } finally {
      performing = false;
      lastTick = performance.now();
      controls.forEach((id) => { $(id).disabled = false; });
    }
  }
  function updateClockBeforePause() {
    const now = performance.now();
    if (durationMs && !isPaused() && timer) remainingMs = Math.max(0, remainingMs - Math.max(0, now - lastTick));
    lastTick = now;
  }
  async function dismiss() {
    return runAction(async () => {
      dismissed = true;
      stopTimer();
      await invoke('dismiss');
    });
  }
  function setHover(value) {
    updateClockBeforePause();
    hovered = value;
    lastTick = performance.now();
    if (timer) updateClock();
  }
  $('card').addEventListener('mouseenter', () => setHover(true));
  $('card').addEventListener('mouseleave', () => setHover(false));
  $('card').addEventListener('focusin', () => {
    updateClockBeforePause();
    focusInside = true;
    if (timer) updateClock();
  });
  $('card').addEventListener('focusout', (event) => {
    if ($('card').contains(event.relatedTarget)) return;
    updateClockBeforePause();
    focusInside = false;
    if (timer) updateClock();
  });
  $('btnClose').addEventListener('click', dismiss);
  $('btnDismiss').addEventListener('click', dismiss);
  $('btnMain').addEventListener('click', () => runAction(async () => {
    await invoke('showMain');
    dismissed = true;
    stopTimer();
    await invoke('dismiss');
  }));
  $('btnOpen').addEventListener('click', () => runAction(async () => {
    if (popupData?.test) await invoke('showMain');
    else await invoke('openExternal', popupData?.url || 'https://courses.zju.edu.cn/user/index');
    dismissed = true;
    stopTimer();
    await invoke('dismiss');
  }));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') dismiss(); });

  async function playChime() {
    try {
      clearTimeout(audioCloseTimer);
      if (audioContext) { await audioContext.close().catch(() => {}); audioContext = null; }
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      audioContext = new Audio();
      if (audioContext.state === 'suspended') await audioContext.resume();
      const now = audioContext.currentTime;
      [659.25, 880].forEach((frequency, index) => {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const start = now + index * .13;
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(.001, start);
        gain.gain.exponentialRampToValueAtTime(.10, start + .025);
        gain.gain.exponentialRampToValueAtTime(.001, start + .6);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(start);
        oscillator.stop(start + .65);
      });
      audioCloseTimer = setTimeout(() => { if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; } }, 1100);
    } catch (error) { console.warn('Notification chime:', messageOf(error)); }
  }
  function displayValue(value, fallback = '') {
    if (value == null || value === '') return fallback;
    if (typeof value === 'object') return value.label || value.name || fallback;
    return String(value);
  }
  function startedAt(value) {
    if (!value) return '';
    const date = new Date(typeof value === 'number' && value < 1e11 ? value * 1000 : value);
    if (!Number.isFinite(date.getTime())) return displayValue(value);
    return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) + ' 发起';
  }
  function show(data) {
    stopTimer();
    popupData = data && typeof data === 'object' ? data : {};
    dismissed = false;
    performing = false;
    hovered = $('card').matches(':hover');
    focusInside = $('card').contains(document.activeElement);
    controls.forEach((id) => { $(id).disabled = false; });
    $('popupError').hidden = true;
    $('card').classList.remove('has-error');
    const autoSigned = popupData.autoSigned === true && !popupData.test;
    $('card').classList.toggle('is-test', !!popupData.test);
    $('card').classList.toggle('is-auto-signed', autoSigned);
    $('typeName').textContent = popupData.test ? '测试提醒 · 非真实签到' : autoSigned ? '自动签到成功' : displayValue(popupData.type, '签到提醒');
    $('courseTitle').textContent = popupData.test ? '这是一条测试提醒' : displayValue(popupData.title, '有新的签到，请及时查看');
    $('teacherName').textContent = popupData.test ? '效果预览' : displayValue(popupData.teacher);
    $('accountBadge').textContent = displayValue(popupData.account);
    $('startTime').textContent = popupData.test ? '' : startedAt(popupData.startedAt);
    $('popupNote').textContent = popupData.test ? '仅验证弹窗与声音，没有发现或提交真实签到。' : autoSigned ? displayValue(popupData.detail, '后端已确认雷达点名签到成功，可到课程平台查看。') : [displayValue(popupData.detail), '请及时前往课程平台查看并完成签到。'].filter(Boolean).join(' ');
    $('popupMode').textContent = popupData.test ? '测试通知 · 未提交真实签到' : autoSigned ? '自动签到成功' : '签到提醒 · 请及时确认';
    $('openLabel').textContent = popupData.test ? '查看主界面' : autoSigned ? '查看签到结果' : '打开课程平台';
    const seconds = Number(popupData.seconds ?? 0);
    durationMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
    remainingMs = durationMs;
    lastTick = performance.now();
    $('progressTrack').hidden = !durationMs;
    $('progressBar').style.transform = 'scaleX(1)';
    updateClock();
    if (durationMs) timer = setInterval(updateClock, 100);
    if (popupData.sound === true) playChime();
  }
  window.addEventListener('error', (event) => errorVisible(event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => { event.preventDefault(); errorVisible(event.reason); });
  if (!api || typeof api.onShow !== 'function') { errorVisible(new Error('弹窗接口未加载，请从桌面 App 发起提醒')); return; }
  try { unsubShow = api.onShow(show); } catch (error) { errorVisible(error); }
  window.addEventListener('beforeunload', () => {
    stopTimer();
    clearTimeout(audioCloseTimer);
    if (audioContext) audioContext.close().catch(() => {});
    if (typeof unsubShow === 'function') unsubShow();
  });
});
