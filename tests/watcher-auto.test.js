import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RollcallWatcher } from '../src/watcher.js';

// 监听器集成测试全量注入账号、登录、查询、应答、点位及通知；不连接网络。
const account = (extra = {}) => ({
  key: 'main', label: '测试主账号', username: '202600000001',
  password: 'fixture-watcher-only', enabled: true, autoAnswer: true, ...extra,
});
const rollcall = (extra = {}) => ({
  id: 101, isRadar: true, active: true, handled: false, expired: false,
  courseTitle: '测试课程', type: '雷达点名', ...extra,
});
const points = [
  { id: 'preferred', name: '测试默认点', lon: 120.1, lat: 30.3 },
  { id: 'other', name: '测试备用点', lon: 120.11, lat: 30.31 },
];

function fixture(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'rollcall-watcher-auto-test-'));
  const config = {
    intervalMs: 30_000, logLimit: 300, notify: true, renotifyMs: 0,
    autoAnswer: true, autoFallback: false, autoDefaultLocation: 'preferred',
    ...options.config,
  };
  const accounts = options.accounts || [account()];
  const calls = { login: [], query: [], answer: [], notify: [] };
  const locations = {
    resolve: (id) => points.find((p) => p.id === id) || null,
    all: () => points,
    snapshot: () => ({ locations: points, defaultId: null, default: null }),
  };
  const watcherOptions = {
    locations,
    accountProvider: () => ({ accounts, source: 'mock-fixture' }),
    login: async (credentials) => {
      calls.login.push(credentials);
      return { jar: { username: credentials.username } };
    },
    clientFactory: (jar) => ({
      rollcalls: async () => {
        calls.query.push(jar.username);
        return options.query ? options.query(jar.username, calls.query.length) : [rollcall()];
      },
      answerRadar: async (id, point) => {
        calls.answer.push({ username: jar.username, id, point });
        return options.answer ? options.answer(id, point, calls.answer.length) : { status: 200, json: { status: 'signed' } };
      },
    }),
    notify: async (payload) => { calls.notify.push(payload); return { shown: true }; },
  };
  if (options.autoSigner) watcherOptions.autoSigner = options.autoSigner;
  const watcher = new RollcallWatcher({ load: () => config }, dataDir, watcherOptions);
  // 不调用 start/schedule，避免真实定时器；这里只测试单次调度路径。
  watcher.running = options.running ?? true;
  t.after(() => { watcher.stop(); rmSync(dataDir, { recursive: true, force: true }); });
  return { watcher, config, accounts, calls };
}

for (const [name, options] of [
  ['暂停监听', { running: false }],
  ['总开关关闭', { config: { autoAnswer: false } }],
  ['账号不参与', { accounts: [account({ autoAnswer: false })] }],
  ['非雷达签到', { query: async () => [rollcall({ isRadar: false, type: '数字点名' })] }],
]) {
  test(`${name}：checkOnce 仍查询和通知但零写`, async (t) => {
    const { watcher, calls } = fixture(t, options);
    const result = await watcher.checkOnce();
    assert.equal(result.ok, true);
    assert.equal(calls.query.length, 1);
    assert.equal(calls.answer.length, 0);
    assert.equal(calls.notify.length, 1);
  });
}

test('自动成功采用同一会话，写成功记录并抑制该点名通知', async (t) => {
  const { watcher, calls } = fixture(t);
  const result = await watcher.checkOnce();
  assert.equal(result.ok, true);
  assert.equal(calls.login.length, 1);
  assert.equal(calls.answer.length, 1);
  assert.deepEqual(result.items, []);
  assert.equal(result.activeCount, 0);
  assert.equal(calls.notify.filter((n) => !n.autoSigned).length, 0, '已成功项目不再发待签到提醒');
  assert.equal(calls.notify.filter((n) => n.autoSigned).length, 1, '发送一次独立的成功结果通知');
  assert.equal(watcher.getStatus().autoHistory[0].state, 'success');
  assert.equal(watcher.autoSigner.history()[0].state, 'success');
  await watcher.checkOnce();
  assert.equal(calls.answer.length, 1, '下一次平台仍回传旧active也不重复应答');
  assert.equal(calls.notify.length, 1, '成功结果通知按attemptId独立去重');
});

test('不同账号相同点名id各自自动应答，未参与/停用账号零写', async (t) => {
  const { watcher, calls } = fixture(t, {
    accounts: [
      account(),
      account({ key: 'a2', username: '202600000002', label: '测试副账号' }),
      account({ key: 'a3', username: '202600000003', autoAnswer: false }),
      account({ key: 'a4', username: '202600000004', enabled: false }),
    ],
  });
  await watcher.checkOnce();
  assert.equal(calls.answer.length, 2);
  assert.deepEqual(new Set(calls.answer.map((c) => c.username)), new Set(['202600000001', '202600000002']));
  assert.equal(calls.query.includes('202600000004'), false);
  assert.equal(calls.notify.filter((n) => n.autoSigned).length, 2);
  assert.equal(calls.notify.filter((n) => !n.autoSigned).length, 1);
});

test('pending 后平台返回handled的完整列表仍交给observe，暂停也能确认成功', async (t) => {
  let handled = false;
  const { watcher, calls } = fixture(t, {
    query: async () => handled ? [rollcall({ active: false, handled: true })] : (calls.query.length === 1 ? [rollcall()] : []),
    answer: async () => ({ status: 200, json: { success: true } }),
  });
  await watcher.checkOnce();
  assert.equal(watcher.autoSigner.history()[0].state, 'pending');
  handled = true;
  watcher.running = false;
  const result = await watcher.checkOnce();
  assert.equal(result.activeCount, 0);
  assert.equal(watcher.autoSigner.history()[0].state, 'success');
  assert.equal(calls.answer.length, 1);
});

test('失败自动应答保留人工通知，通知带结果说明', async (t) => {
  const { watcher, calls } = fixture(t, {
    answer: async () => ({ status: 200, json: { error_code: 'fixture-too-far', distance: 600 } }),
  });
  await watcher.checkOnce();
  assert.equal(calls.answer.length, 1);
  assert.equal(calls.notify.length, 1);
  assert.match(calls.notify[0].detail, /fixture-too-far|未确认|60/);
});

for (const mode of ['stop', 'config', 'disable', 'participation', 'password', 'location', 'remove']) {
  test(`在首个应答后 ${mode} 变化，canContinue 阻止后续fallback`, async (t) => {
    let f;
    f = fixture(t, {
      config: { autoFallback: true },
      answer: async () => {
        if (mode === 'stop') f.watcher.stop();
        if (mode === 'config') f.config.autoAnswer = false;
        if (mode === 'disable') f.accounts[0] = { ...f.accounts[0], enabled: false };
        if (mode === 'participation') f.accounts[0] = { ...f.accounts[0], autoAnswer: false };
        if (mode === 'password') f.accounts[0] = { ...f.accounts[0], password: 'changed-fixture-password' };
        if (mode === 'location') f.accounts[0] = { ...f.accounts[0], location: 'other' };
        if (mode === 'remove') f.accounts.splice(0);
        return { status: 200, json: { error_code: 'too_far', distance: 600 } };
      },
    });
    await f.watcher.checkOnce();
    assert.equal(f.calls.answer.length, 1);
    assert.equal(f.watcher.autoSigner.busy, false);
  });
}

test('自动服务异常不打断其他通知/账号查询', async (t) => {
  const autoSigner = {
    busy: false, history: () => [], observe: () => {},
    run: async () => { throw new Error('fixture auto service failure'); },
  };
  const { watcher, calls } = fixture(t, { autoSigner });
  const result = await watcher.checkOnce();
  assert.equal(result.ok, true);
  assert.equal(calls.notify.length, 1);
  assert.equal(result.items[0].autoState, 'failed');
  assert.ok(watcher.logs.some((r) => r.message.includes('fixture auto service failure')));
});
