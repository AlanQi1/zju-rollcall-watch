import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { casLogin } from './zjuam.js';
import { CoursesClient, COURSES } from './courses.js';
import { resolveAccounts, maskAccount, accountsFile } from './accounts.js';
import { LocationStore } from './locations.js';
import { AutoSigner } from './auto-sign.js';

// 查询与自动签到统一调度；总开关关闭/暂停时只读。所有通知走同一条桌面链路。
export class RollcallWatcher extends EventEmitter {
  constructor(configStore, dataDir, options = {}) {
    super();
    this.configStore = configStore;
    this.dataDir = dataDir;
    this.notify = options.notify || (async () => {});
    this.accountProvider = options.accountProvider || (() => resolveAccounts(dataDir));
    this.login = options.login || casLogin;
    this.clientFactory = options.clientFactory || ((jar) => new CoursesClient(jar));
    this.sessions = new Map();
    this.accountStates = new Map();
    this.logs = [];
    this.running = false;
    this.checking = false;
    this.timer = null;
    this.pending = null;
    this.lastCheckAt = null;
    this.lastSuccessAt = null;
    this.lastError = '';
    this.nextCheckAt = null;
    this.lastActiveRollcalls = [];
    this.stateFile = join(dataDir, 'reminded.json');
    this.seen = new Map();
    try {
      const stored = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      for (const [key, time] of Object.entries(stored)) {
        if (Number(time) > Date.now() - 7 * 86400000) this.seen.set(key, Number(time));
      }
    } catch { /* 首次运行没有提醒记录 */ }
    this.locations = options.locations || new LocationStore(dataDir);
    this.autoSigner = options.autoSigner || new AutoSigner(dataDir, { getConfig: () => this.configStore.load(), locations: this.locations, log: (level, message) => this.log(level, message), changed: () => this.changed() });
  }

  log(level, message) {
    const entry = { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level, message: String(message) };
    this.logs.unshift(entry);
    this.logs.length = Math.min(this.logs.length, this.configStore.load().logLimit || 300);
    this.emit('log', entry);
  }

  changed() { this.emit('status', this.getStatus()); }

  persistSeen() {
    const cutoff = Date.now() - 7 * 86400000;
    for (const [key, time] of this.seen) if (time < cutoff) this.seen.delete(key);
    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(Object.fromEntries(this.seen)), 'utf8');
      renameSync(`${this.stateFile}.tmp`, this.stateFile);
    } catch (error) { this.log('warn', `提醒记录保存失败：${error.message}`); }
  }

  fingerprint(account) {
    return createHash('sha256').update(`${account.username}\0${account.password}`).digest('hex');
  }

  async getClient(account, force = false) {
    const fingerprint = this.fingerprint(account);
    const cached = this.sessions.get(account.key);
    if (!force && cached?.fingerprint === fingerprint) return cached.client;
    this.sessions.delete(account.key);
    this.log('info', `连接 ${account.label}（${maskAccount(account.username)}）`);
    const { jar } = await this.login({ landingUrl: `${COURSES}/login`, username: account.username, password: account.password });
    const client = this.clientFactory(jar);
    this.sessions.set(account.key, { client, fingerprint });
    return client;
  }

  async checkAccount(account, config) {
    const previous = this.accountStates.get(account.key) || {};
    if (previous.retryAt > Date.now()) {
      return { ok: false, accountKey: account.key, error: previous.error, items: [] };
    }
    this.accountStates.set(account.key, { ...previous, checking: true });
    try {
      let client = await this.getClient(account);
      let items;
      try { items = await client.rollcalls(); }
      catch (error) {
        if (!config.autoRelogin || !/HTTP (401|403|302)|会话|登录/i.test(error.message)) throw error;
        this.sessions.delete(account.key);
        client = await this.getClient(account, true);
        items = await client.rollcalls();
      }
      this.accountStates.set(account.key, { checking: false, error: '', failCount: 0, retryAt: 0, lastSuccessAt: Date.now() });
      const allItems = items.map((rc) => ({ ...rc, accountKey: account.key, accountLabel: account.label, username: maskAccount(account.username) }));
      return { ok: true, accountKey: account.key, allItems, items: allItems.filter((rc) => rc.active) };
    } catch (error) {
      this.sessions.delete(account.key);
      const failCount = (previous.failCount || 0) + 1;
      // 断网/错误密码指数退避，避免每30秒重复提交登录密码。
      const delay = Math.min(15 * 60000, 30000 * 2 ** Math.min(failCount - 1, 5));
      const message = String(error.message || error).replace(/<[^>]*>/g, '').slice(0, 240);
      this.accountStates.set(account.key, { ...previous, checking: false, error: message, failCount, retryAt: Date.now() + delay });
      this.log('error', `${account.label}：${message}；${Math.round(delay / 1000)} 秒后重试`);
      return { ok: false, accountKey: account.key, error: message, items: [] };
    }
  }

  checkOnce() {
    if (this.pending) return this.pending;
    this.pending = this.performCheck().finally(() => {
      this.pending = null;
      this.checking = false;
      this.changed();
    });
    return this.pending;
  }

  async performCheck() {
    this.checking = true;
    this.lastCheckAt = Date.now();
    this.changed();
    try {
      const config = this.configStore.load();
      const accounts = this.accountProvider().accounts.filter((a) => a.enabled !== false);
      if (!accounts.length) {
        this.lastActiveRollcalls = [];
        this.lastError = '请先在「账号」中添加学号与密码';
        return { ok: false, reason: this.lastError, items: [], activeCount: 0 };
      }
      const enabledKeys = new Set(accounts.map((a) => a.key));
      for (const key of this.sessions.keys()) if (!enabledKeys.has(key)) this.sessions.delete(key);
      // 两个账号并行查询，减少短时点名的发现延迟。
      const results = [];
      for (let i = 0; i < accounts.length; i += 3) {
        results.push(...await Promise.all(accounts.slice(i, i + 3).map((a) => this.checkAccount(a, config))));
      }
      for (const result of results.filter((r) => r.ok)) {
        this.autoSigner.observe(accounts.find((a) => a.key === result.accountKey), result.allItems || result.items);
      }
      const items = results.flatMap((r) => r.items);
      this.lastActiveRollcalls = items;
      const successes = results.filter((r) => r.ok).length;
      this.lastError = results.filter((r) => !r.ok).map((r) => `${accounts.find((a) => a.key === r.accountKey)?.label}：${r.error}`).join('；');
      if (successes) this.lastSuccessAt = Date.now();
      this.log(successes === accounts.length ? 'success' : 'warn', `检查完成：${successes}/${accounts.length} 个账号连接正常，${items.length} 项待签到`);
      for (const rc of items) {
        const account = accounts.find((a) => a.key === rc.accountKey);
        if (config.autoAnswer && this.running && account.autoAnswer !== false && rc.isRadar) {
          const fingerprint = this.fingerprint(account);
          const canContinue = () => {
            if (!this.running || !this.configStore.load().autoAnswer) return false;
            const latest = this.accountProvider().accounts.find((a) => a.key === account.key);
            return !!latest && latest.enabled !== false && latest.autoAnswer !== false && this.fingerprint(latest) === fingerprint && String(latest.location || '') === String(account.location || '');
          };
          try {
            const outcome = await this.autoSigner.run(account, rc, await this.getClient(account), canContinue);
            if (outcome) { rc.autoState = outcome.state; rc.autoMessage = outcome.message; }
          } catch (error) { rc.autoState = 'failed'; rc.autoMessage = '自动签到执行异常，请查看日志'; this.log('error', `自动签到执行异常：${error.message}`); }
        }
        if (rc.autoState === 'success') continue;
        const key = `${account.username}:${rc.id}`;
        const seenAt = this.seen.get(key);
        const due = !seenAt || (config.renotifyMs > 0 && Date.now() - seenAt >= config.renotifyMs);
        if (!config.notify || !due) continue;
        try {
          const result = await this.notify({ type: rc.type, title: rc.courseTitle || rc.title || '新的课堂签到', teacher: rc.teacher, account: rc.accountLabel, startedAt: rc.startedAt, url: rc.url || `${COURSES}/user/index`, sound: config.notifySound, seconds: config.notifySeconds, accountKey: rc.accountKey, rollcallId: rc.id, detail: rc.autoMessage || '' });
          if (result?.shown === false) throw new Error('提醒窗口创建失败');
          this.seen.set(key, Date.now());
          this.persistSeen();
          this.log('info', `已提醒：${rc.courseTitle || rc.title} · ${rc.accountLabel}`);
        } catch (error) { this.log('error', `通知发送失败：${error.message}`); }
      }
      this.lastActiveRollcalls = items.filter((rc) => rc.autoState !== 'success');
      // 包括上轮提交后本轮回读才确认成功的项目；结果通知与待签提醒分开去重。
      for (const result of this.autoSigner.history().filter((r) => r.state === 'success')) {
        const key = `auto:${result.attemptId}`;
        if (!config.notify || this.seen.has(key)) continue;
        try {
          await this.notify({ type: '自动签到成功', title: result.courseTitle, account: result.accountLabel, detail: result.message, autoSigned: true, sound: config.notifySound, seconds: config.notifySeconds, url: `${COURSES}/user/index` });
          this.seen.set(key, Date.now()); this.persistSeen();
        } catch (error) { this.log('error', `签到结果通知失败：${error.message}`); }
      }
      return { ok: successes === accounts.length, activeCount: this.lastActiveRollcalls.length, items: this.lastActiveRollcalls, reason: this.lastError };
    } catch (error) {
      this.lastError = String(error.message || error);
      this.log('error', this.lastError);
      return { ok: false, reason: this.lastError, items: [], activeCount: 0 };
    }
  }

  schedule() {
    clearTimeout(this.timer);
    if (!this.running) return;
    const delay = this.configStore.load().intervalMs;
    this.nextCheckAt = Date.now() + delay;
    this.changed();
    this.timer = setTimeout(async () => {
      this.nextCheckAt = null;
      await this.checkOnce();
      this.schedule();
    }, delay);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.log('info', '已开始监听；关闭窗口后仍在托盘运行');
    this.changed();
    this.checkOnce().finally(() => { if (this.running) this.schedule(); });
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.nextCheckAt = null;
    this.log('info', '监听已暂停');
    this.changed();
  }

  reschedule() { if (this.running && !this.checking) this.schedule(); }

  getStatus() {
    const config = this.configStore.load();
    let accounts = [], source = null, credentialError = '';
    try { ({ accounts, source } = this.accountProvider()); }
    catch (error) { credentialError = `账号配置读取失败：${error.message}`; }
    return {
      running: this.running, checking: this.checking, intervalMs: config.intervalMs,
      notify: config.notify, notifySound: config.notifySound, notifySeconds: config.notifySeconds,
      autoAnswer: config.autoAnswer, autoDefaultLocation: config.autoDefaultLocation, autoFallback: config.autoFallback,
      autoHistory: this.autoSigner?.history() || [], autoSigning: this.autoSigner?.busy || false, autoError: this.autoSigner?.storageError || '', credentialSource: source, accountsEnvFile: accountsFile(this.dataDir),
      lastCheckAt: this.lastCheckAt, nextCheckAt: this.nextCheckAt, lastSuccessAt: this.lastSuccessAt, lastError: credentialError || this.lastError,
      accounts: accounts.map((a) => {
        const state = this.accountStates.get(a.key) || {};
        return { key: a.key, label: a.label, username: maskAccount(a.username), primary: a.primary, enabled: a.enabled, location: a.location || '', autoAnswer: a.autoAnswer !== false, sessionActive: this.sessions.has(a.key) && !state.error, error: state.error || '', lastSuccessAt: state.lastSuccessAt || null, retryAt: state.retryAt || null };
      }),
      activeRollcalls: this.lastActiveRollcalls,
    };
  }
}
