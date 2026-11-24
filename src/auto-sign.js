import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocationStore, normalizePoint } from './locations.js';
import { estimatePosition, extractDistance } from './trilateration.js';

const SIGNED = new Set(['on_call', 'on_call_fine', 'present', 'signed', 'signed_in']);
const RETRY_MS = 60000;
const MAX_ROUNDS = 2;
const MAX_WRITES = 20;
function explicitSuccess(payload) {
  if (!payload || typeof payload !== 'object' || payload.error_code || payload.error) return false;
  return [payload, payload.data, payload.result, payload.rollcall].some((part) => part && [part.status, part.status_name, part.rollcall_status].some((value) => SIGNED.has(String(value || '').toLowerCase())));
}
function cleanMessage(value, account) {
  let text = String(value || '').replace(/<[^>]*>/g, '').replace(/[\r\n]+/g, ' ').slice(0, 300);
  for (const secret of [account.password, account.username].filter(Boolean)) text = text.split(String(secret)).join('***');
  return text;
}

/** 自动雷达签到：先持久化意图，再提交；明确确认成功后才标记成功。 */
export class AutoSigner {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.file = join(dataDir, 'auto-sign.json');
    this.getConfig = options.getConfig || (() => ({}));
    this.locations = options.locations || new LocationStore(dataDir);
    this.log = options.log || (() => {});
    this.changed = options.changed || (() => {});
    this.now = options.now || Date.now;
    this.records = new Map();
    this.inFlight = new Map();
    this.storageError = '';
    try {
      const stored = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(stored.records)) throw new Error('自动签到记录格式异常');
      for (const record of stored.records) {
        if (record.key && record.updatedAt > this.now() - 7 * 86400000) this.records.set(record.key, record);
      }
    } catch (error) {
      // 损坏的历史不当成空历史，以免重新提交已处理的点名。
      if (error.code !== 'ENOENT') this.storageError = '自动签到记录读取失败，请先检查数据目录中的 auto-sign.json';
    }
  }
  get busy() { return this.inFlight.size > 0; }
  key(account, rollcall) {
    return `${createHash('sha256').update(String(account.username)).digest('hex')}:${String(rollcall.id)}`;
  }
  publicRecord(record) {
    const { accountKey, accountLabel, rollcallId, courseTitle, state, message, locationName, attempts, updatedAt, attemptId } = record;
    return { accountKey, accountLabel, rollcallId, courseTitle, state, message, locationName, attempts, updatedAt, attemptId };
  }
  history() { return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30).map((record) => this.publicRecord(record)); }
  persist() {
    mkdirSync(this.dataDir, { recursive: true });
    const records = [...this.records.values()].filter((record) => record.updatedAt > this.now() - 7 * 86400000).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 500);
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, records }), { encoding: 'utf8', mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
  finish(record, state, message) {
    record.state = state;
    record.message = message;
    record.updatedAt = this.now();
    if (state === 'success') record.nextRetryAt = 0;
    this.records.set(record.key, record);
    try { this.persist(); }
    catch (error) { this.storageError = '自动签到记录保存失败，已停止后续自动提交'; this.log('error', this.storageError); }
    this.log(state === 'success' ? 'success' : state === 'failed' ? 'error' : 'info', `自动签到 · ${record.accountLabel} · ${record.courseTitle}：${message}`);
    this.changed();
    return this.publicRecord(record);
  }
  observe(account, items) {
    for (const rollcall of items) {
      const record = this.records.get(this.key(account, rollcall));
      if (!record || record.state === 'success') continue;
      if (rollcall.handled) this.finish(record, 'success', '平台回读确认已签到');
      else if (rollcall.expired) this.finish(record, 'failed', '点名已结束，平台未确认签到成功');
    }
  }
  run(account, rollcall, client, canContinue = () => true) {
    const config = this.getConfig();
    if (!config.autoAnswer || account.autoAnswer === false || account.enabled === false || !rollcall.isRadar || !rollcall.active || rollcall.handled || rollcall.expired || !canContinue()) return Promise.resolve(null);
    const key = this.key(account, rollcall);
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const promise = this.perform(account, rollcall, client, canContinue).finally(() => { this.inFlight.delete(key); this.changed(); });
    this.inFlight.set(key, promise);
    this.changed();
    return promise;
  }
  async perform(account, rollcall, client, canContinue) {
    const key = this.key(account, rollcall);
    const previous = this.records.get(key);
    if (previous?.state === 'success') return this.publicRecord(previous);
    const config = this.getConfig();
    const locationText = String(account.location || config.autoDefaultLocation || '').trim();
    const plan = `${locationText}:${Boolean(config.autoFallback)}`;
    let record = previous;
    if (!record || record.plan !== plan) {
      record = { key, accountKey: account.key, accountLabel: account.label, rollcallId: rollcall.id, courseTitle: rollcall.courseTitle || rollcall.title || '课堂签到', state: 'pending', message: '', locationName: '', attempts: 0, rounds: 0, updatedAt: this.now(), nextRetryAt: 0, attemptId: randomUUID(), deviceId: randomUUID(), plan };
    }
    // 读取损坏的历史时保留原文件，不通过 finish() 覆写后在重启时丢失去重依据。
    if (this.storageError) return this.publicRecord({ ...record, state: 'failed', message: this.storageError, updatedAt: this.now() });
    if (record.rounds >= MAX_ROUNDS || record.nextRetryAt > this.now()) return this.publicRecord(record);
    let preferred;
    try {
      if (!locationText) throw new Error('请先在设置或账号中选择签到位置');
      preferred = this.locations.resolve(locationText);
      if (!preferred) throw new Error(`签到位置未识别：${locationText}`);
      normalizePoint(preferred.lon, preferred.lat);
    } catch (error) { return this.finish(record, 'failed', cleanMessage(error.message, account)); }
    const allowed = () => {
      const current = this.getConfig();
      return current.autoAnswer === true && account.enabled !== false && account.autoAnswer !== false && String(account.location || current.autoDefaultLocation || '').trim() === locationText && Boolean(current.autoFallback) === Boolean(config.autoFallback) && canContinue();
    };
    if (!allowed()) return null;
    if (previous?.state === 'pending' && previous.attempts > 0) {
      // 上轮请求结果不明时，先重新读取，明确仍待签到才允许重试。
      try {
        const fresh = (await client.rollcalls()).find((item) => String(item.id) === String(rollcall.id));
        if (fresh?.handled) return this.finish(record, 'success', '平台回读确认已签到，未重复提交');
        if (fresh?.expired) return this.finish(record, 'failed', '点名已结束，平台未确认签到成功');
        if (!fresh?.active) return this.finish(record, 'pending', '平台暂未返回待签到状态，继续等待确认');
      } catch { return this.finish(record, 'pending', '平台状态仍未确认，暂不重复提交'); }
      if (!allowed()) return this.finish(record, 'skipped', '自动签到已暂停，未重复提交');
    }
    record.rounds += 1;
    record.state = 'pending';
    record.message = '正在向平台提交签到';
    record.nextRetryAt = this.now() + RETRY_MS;
    record.updatedAt = this.now();
    this.records.set(key, record);
    try { this.persist(); }
    catch { this.storageError = '自动签到记录保存失败，已停止后续自动提交'; return this.finish(record, 'failed', this.storageError); }
    this.changed();
    const queue = [preferred, ...(config.autoFallback ? this.locations.all() : [])];
    const visited = new Set();
    const measurements = [];
    let roundWrites = 0, failure = '', ambiguous = false, estimated = false;
    while (queue.length && roundWrites < MAX_WRITES) {
      if (!allowed()) return this.finish(record, 'skipped', '自动签到已暂停或配置已更改，剩余提交已取消');
      const point = queue.shift();
      const coordinateKey = `${point.lon},${point.lat}`;
      if (visited.has(coordinateKey)) continue;
      visited.add(coordinateKey);
      record.locationName = point.name || coordinateKey;
      record.attempts += 1;
      record.updatedAt = this.now();
      // 意图落盘失败时不发送请求；请求成功但进程退出时下次会先按查询结果核对。
      try { this.persist(); }
      catch { this.storageError = '自动签到记录保存失败，已停止后续自动提交'; return this.finish(record, 'failed', this.storageError); }
      roundWrites += 1;
      this.changed();
      let response;
      try { response = await client.answerRadar(rollcall.id, { ...normalizePoint(point.lon, point.lat), deviceId: record.deviceId }); }
      catch (error) { failure = cleanMessage(error.message, account) || '提交请求中断'; ambiguous = true; break; }
      const ok = response.status >= 200 && response.status < 300;
      if (ok && explicitSuccess(response.json)) return this.finish(record, 'success', '平台已确认自动签到成功');
      failure = cleanMessage(response.json?.message || response.json?.error_message || response.json?.error_code || `平台未确认成功（HTTP ${response.status}）`, account);
      const distance = extractDistance(response.json);
      if (distance !== null) measurements.push({ lon: point.lon, lat: point.lat, d: distance });
      if (!config.autoFallback || distance === null || [401, 403, 404, 429].includes(response.status)) break;
      if (!estimated && measurements.length >= 3) {
        const estimate = estimatePosition(measurements);
        if (estimate?.reliable) { queue.unshift({ ...estimate, name: '距离回读推算点' }); estimated = true; }
      }
    }
    // success:true 仅表示请求受理时，不直接冒充“已签到”；用平台状态回读。
    try {
      const items = await client.rollcalls();
      const confirmed = items.find((item) => String(item.id) === String(rollcall.id));
      if (confirmed?.handled) return this.finish(record, 'success', '平台回读确认自动签到成功');
      if (confirmed?.expired) return this.finish(record, 'failed', '点名已结束，平台未确认签到成功');
      if (confirmed?.active) return this.finish(record, 'failed', `${failure || '回读仍为待签到'}；${record.rounds < MAX_ROUNDS ? '60 秒后最多再试一轮' : '已达两轮上限，请手动处理'}`);
      return this.finish(record, 'pending', '已提交，平台列表暂未返回该签到，等待后续确认');
    } catch {
      return this.finish(record, ambiguous ? 'pending' : 'failed', ambiguous ? '提交结果暂未确认，等待后续查询；暂不盲目重复提交' : `${failure || '提交未成功'}；结果回读失败`);
    }
  }
}
