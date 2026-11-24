import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RollcallWatcher } from '../src/watcher.js';
import { ConfigStore, DEFAULTS } from '../src/config.js';
import { CoursesClient } from '../src/courses.js';

const account = (overrides = {}) => ({
  key: 'main', label: '测试主账号', username: '202600000001',
  password: 'test-only-password', enabled: true, primary: true, ...overrides,
});
const rollcall = (overrides = {}) => ({
  id: 101, active: true, courseTitle: '测试课程', type: '雷达点名', ...overrides,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture(t, options = {}) {
  const dataDir = options.dataDir || mkdtempSync(join(tmpdir(), 'rollcall-watcher-test-'));
  const configStore = new ConfigStore(dataDir);
  // 直接注入合法 JSON 配置，聚焦监听逻辑，不把配置写入实现混入本组断言。
  const config = { ...DEFAULTS, renotifyMs: 0, ...options.config };
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config));
  const accounts = options.accounts ?? [account()];
  const calls = { login: [], query: [], notify: [] };
  const watcherOptions = {
    accountProvider: () => ({ accounts, source: 'test-fixture' }),
    login: async (credentials) => {
      calls.login.push(credentials);
      if (options.login) return options.login(credentials, calls.login.length);
      return { jar: { username: credentials.username, password: credentials.password, serial: calls.login.length } };
    },
    clientFactory: (jar) => ({
      rollcalls: async () => {
        calls.query.push(jar);
        return options.query ? options.query(jar, calls.query.length) : [rollcall()];
      },
    }),
    notify: async (payload) => {
      calls.notify.push(payload);
      return options.notify ? options.notify(payload, calls.notify.length) : { shown: true };
    },
  };
  if (options.accountProvider) watcherOptions.accountProvider = options.accountProvider;
  // 使用真实 resolveAccounts 读损坏文件，其他测试始终注入虚拟账号，零联网。
  if (options.realAccounts) delete watcherOptions.accountProvider;
  const watcher = new RollcallWatcher(configStore, dataDir, watcherOptions);
  t.after(() => {
    watcher.stop();
    if (!options.dataDir) rmSync(dataDir, { recursive: true, force: true });
  });
  return { watcher, dataDir, configStore, accounts, calls };
}

test('checkOnce 并发返回同一个 Promise，且只登录、查询、通知一次', { timeout: 3000 }, async (t) => {
  const entered = deferred();
  const gate = deferred();
  const { watcher, calls } = fixture(t, {
    query: async () => { entered.resolve(); await gate.promise; return [rollcall()]; },
  });
  const first = watcher.checkOnce();
  const second = watcher.checkOnce();
  try {
    assert.strictEqual(first, second);
    await entered.promise;
    assert.equal(watcher.checking, true);
    assert.equal(calls.login.length, 1);
    assert.equal(calls.query.length, 1);
  } finally { gate.resolve(); }
  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(a, b);
  assert.equal(a.ok, true);
  assert.equal(calls.notify.length, 1);
  assert.equal(watcher.pending, null);
  assert.equal(watcher.checking, false);
});

test('notify=false 仍查询待签到，但不弹窗且不消耗去重记录', async (t) => {
  const { watcher, calls } = fixture(t, { config: { notify: false } });
  const result = await watcher.checkOnce();
  assert.equal(result.ok, true);
  assert.equal(result.activeCount, 1);
  assert.equal(calls.query.length, 1);
  assert.equal(calls.notify.length, 0);
  assert.equal(watcher.seen.size, 0);
});

test('同账号同签到去重，提醒记录持久化后跨实例生效', async (t) => {
  const first = fixture(t);
  await first.watcher.checkOnce();
  await first.watcher.checkOnce();
  assert.equal(first.calls.query.length, 2);
  assert.equal(first.calls.notify.length, 1);
  const saved = JSON.parse(readFileSync(join(first.dataDir, 'reminded.json'), 'utf8'));
  assert.equal(Object.keys(saved).length, 1);
  assert.ok(saved[`${first.accounts[0].username}:101`] > 0);
  const second = fixture(t, { dataDir: first.dataDir });
  const result = await second.watcher.checkOnce();
  assert.equal(result.ok, true);
  assert.equal(second.calls.query.length, 1);
  assert.equal(second.calls.notify.length, 0);
});

test('相同签到 id 的不同账号分别提醒，避免跨账号错误去重', async (t) => {
  const { watcher, calls } = fixture(t, {
    accounts: [account(), account({ key: 'a2', username: '202600000002', label: '测试副账号', primary: false })],
  });
  await watcher.checkOnce();
  await watcher.checkOnce();
  assert.equal(calls.notify.length, 2);
  assert.deepEqual(new Set(calls.notify.map((item) => item.accountKey)), new Set(['main', 'a2']));
});

test('通知失败不写入去重，下轮重试成功后才持久化', async (t) => {
  for (const mode of ['reject', 'shown-false']) {
    await t.test(mode, async (t) => {
      const { watcher, calls, dataDir } = fixture(t, {
        notify: async (_payload, number) => {
          if (number === 1) {
            if (mode === 'reject') throw new Error('mock notification failure');
            return { shown: false };
          }
          return { shown: true };
        },
      });
      assert.equal((await watcher.checkOnce()).ok, true);
      assert.equal(watcher.seen.size, 0);
      assert.ok(watcher.logs.some((entry) => entry.message.includes('通知发送失败')));
      await watcher.checkOnce();
      assert.equal(calls.notify.length, 2);
      assert.equal(watcher.seen.size, 1);
      assert.equal(Object.keys(JSON.parse(readFileSync(join(dataDir, 'reminded.json'), 'utf8'))).length, 1);
      await watcher.checkOnce();
      assert.equal(calls.notify.length, 2);
    });
  }
});

test('缓存 session 遇到 HTTP 401 时重新登录并重试查询', async (t) => {
  let expired = false;
  const { watcher, calls } = fixture(t, {
    query: async (jar) => {
      if (expired && jar.serial === 1) throw new Error('签到查询失败（HTTP 401）');
      return [rollcall()];
    },
  });
  assert.equal((await watcher.checkOnce()).ok, true);
  expired = true;
  const result = await watcher.checkOnce();
  assert.equal(result.ok, true);
  assert.equal(calls.login.length, 2);
  assert.equal(calls.query.length, 3);
  assert.equal(watcher.sessions.get('main').client !== undefined, true);
  assert.equal(watcher.getStatus().accounts[0].sessionActive, true);
});

test('双账号一个失败时整体 ok=false，另一个仍成功查询和通知', async (t) => {
  const { watcher, calls } = fixture(t, {
    accounts: [account(), account({ key: 'a2', username: '202600000002', label: '测试副账号', primary: false })],
    query: async (jar) => {
      if (jar.username === '202600000001') throw new Error('mock network offline');
      return [rollcall()];
    },
  });
  const result = await watcher.checkOnce();
  assert.equal(result.ok, false);
  assert.equal(result.activeCount, 1);
  assert.equal(result.items[0].accountKey, 'a2');
  assert.match(result.reason, /mock network offline/);
  assert.equal(calls.query.length, 2);
  assert.equal(calls.notify.length, 1);
  assert.equal(calls.notify[0].accountKey, 'a2');
  assert.equal(watcher.getStatus().accounts.find((item) => item.key === 'a2').sessionActive, true);
});

test('无账号返回 ok=false，不登录、不查询、不通知', async (t) => {
  const { watcher, calls } = fixture(t, { accounts: [] });
  const result = await watcher.checkOnce();
  assert.equal(result.ok, false);
  assert.equal(result.activeCount, 0);
  assert.deepEqual(result.items, []);
  assert.match(result.reason, /账号/);
  assert.equal(calls.login.length + calls.query.length + calls.notify.length, 0);
});

test('账号配置损坏时 getStatus 和 checkOnce 均返回错误状态而不崩溃', async (t) => {
  for (const contents of ['{broken JSON', '{"accounts":[]}']) {
    await t.test(contents, async (t) => {
      const { watcher, dataDir, calls } = fixture(t, { realAccounts: true });
      writeFileSync(join(dataDir, 'accounts.json'), contents);
      let status;
      assert.doesNotThrow(() => { status = watcher.getStatus(); });
      assert.deepEqual(status.accounts, []);
      assert.match(status.lastError, /账号配置读取失败/);
      const result = await watcher.checkOnce();
      assert.equal(result.ok, false);
      assert.ok(result.reason.length > 0);
      assert.equal(watcher.checking, false);
      assert.equal(watcher.pending, null);
      assert.equal(calls.login.length + calls.query.length, 0);
    });
  }
});

test('暂停已排定监听后清除计时器，推进时间也不发起新查询', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watcher, calls } = fixture(t);
  watcher.start();
  await watcher.pending;
  await Promise.resolve();
  assert.ok(watcher.nextCheckAt > 0);
  assert.equal(calls.query.length, 1);
  watcher.stop();
  assert.equal(watcher.running, false);
  assert.equal(watcher.timer, null);
  assert.equal(watcher.nextCheckAt, null);
  watcher.schedule();
  watcher.reschedule();
  t.mock.timers.tick(600000);
  await Promise.resolve();
  assert.equal(calls.query.length, 1);
  assert.equal(watcher.nextCheckAt, null);
});

test('检查尚未结束时暂停，完成后也不重新调度', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred();
  const { watcher, calls } = fixture(t, { query: async () => { await gate.promise; return []; } });
  watcher.start();
  const pending = watcher.pending;
  watcher.stop();
  gate.resolve();
  await pending;
  await Promise.resolve();
  t.mock.timers.tick(600000);
  assert.equal(calls.query.length, 1);
  assert.equal(watcher.timer, null);
  assert.equal(watcher.nextCheckAt, null);
  assert.equal(watcher.running, false);
});

test('disabled 账号不登录、不查询，其余启用账号照常工作', async (t) => {
  const { watcher, calls } = fixture(t, {
    accounts: [account({ enabled: false }), account({ key: 'a2', username: '202600000002' })],
  });
  const result = await watcher.checkOnce();
  assert.equal(result.ok, true);
  assert.equal(calls.login.length, 1);
  assert.equal(calls.login[0].username, '202600000002');
  assert.equal(calls.query.length, 1);
  assert.equal(result.items[0].accountKey, 'a2');
});

test('全部账号 disabled 时返回 ok=false 且无查询', async (t) => {
  const { watcher, calls } = fixture(t, { accounts: [account({ enabled: false })] });
  assert.equal((await watcher.checkOnce()).ok, false);
  assert.equal(calls.login.length + calls.query.length, 0);
});

test('修改 password 后原 session 失效，使用新密码重新登录', async (t) => {
  const { watcher, accounts, calls } = fixture(t);
  await watcher.checkOnce();
  await watcher.checkOnce();
  assert.equal(calls.login.length, 1);
  const oldClient = watcher.sessions.get('main').client;
  accounts[0].password = 'replacement-test-password';
  assert.equal((await watcher.checkOnce()).ok, true);
  assert.equal(calls.login.length, 2);
  assert.equal(calls.login[1].password, 'replacement-test-password');
  assert.notStrictEqual(watcher.sessions.get('main').client, oldClient);
  assert.equal(calls.query.at(-1).password, 'replacement-test-password');
});

test('状态、通知、成功日志只展示脱敏学号，不含密码', async (t) => {
  const { watcher, accounts, calls } = fixture(t);
  await watcher.checkOnce();
  const publicData = JSON.stringify({ status: watcher.getStatus(), logs: watcher.logs, notifications: calls.notify });
  assert.equal(publicData.includes(accounts[0].password), false);
  assert.equal(publicData.includes(accounts[0].username), false);
  assert.equal(watcher.getStatus().accounts[0].username, '202***01');
  assert.equal(watcher.getStatus().activeRollcalls[0].username, '202***01');
});

class FixtureCoursesClient extends CoursesClient {
  constructor(response) { super(null); this.response = response; this.paths = []; }
  async json(path) { this.paths.push(path); return this.response; }
}

test('CoursesClient: not_on_call 不误判已签，精确匹配已签状态及过期字段', async () => {
  const client = new FixtureCoursesClient({ status: 200, json: { rollcalls: [
    { rollcall_id: 1, status: 'not_on_call' },
    { rollcall_id: 2, rollcall_status: 'not_on_call' },
    { rollcall_id: 3, status: 'on_call' },
    { rollcall_id: 4, status: 'ON_CALL_FINE' },
    { rollcall_id: 5, rollcall_status: 'signed_in' },
    { rollcall_id: 6, status: 'not_on_call', is_expired: true },
    { rollcall_id: 7, status: 'not_on_call', is_expired: 1 },
    { rollcall_id: 8, status: 'present' },
    { rollcall_id: 9, status: 'signed' },
  ] } });
  const items = await client.rollcalls();
  assert.deepEqual(client.paths, ['/api/radar/rollcalls']);
  assert.deepEqual(items.filter((item) => item.active).map((item) => item.id), [1, 2]);
  assert.equal(items[0].handled, false);
  assert.equal(items[1].handled, false);
  for (const index of [2, 3, 4, 7, 8]) assert.equal(items[index].handled, true);
  assert.equal(items[5].expired, true);
  assert.equal(items[6].expired, true);
});

test('CoursesClient: 响应缺少 rollcalls 或类型异常必须报错，空数组合法', async (t) => {
  for (const payload of [{}, { rollcalls: null }, { rollcalls: {} }, { rollcalls: 'bad' }]) {
    await t.test(JSON.stringify(payload), async () => {
      const client = new FixtureCoursesClient({ status: 200, json: payload });
      await assert.rejects(client.rollcalls(), /响应结构异常/);
    });
  }
  const empty = new FixtureCoursesClient({ status: 200, json: { rollcalls: [] } });
  assert.deepEqual(await empty.rollcalls(), []);
});

test('CoursesClient: HTTP 401/403/302 和非 JSON 响应抛出可识别错误', async (t) => {
  for (const status of [401, 403, 302, 500]) {
    await t.test(`HTTP ${status}`, async () => {
      const client = new FixtureCoursesClient({ status, json: { rollcalls: [] } });
      await assert.rejects(client.rollcalls(), new RegExp(`HTTP ${status}`));
    });
  }
  await assert.rejects(new FixtureCoursesClient({ status: 200, json: null }).rollcalls(), /签到查询失败/);
});
