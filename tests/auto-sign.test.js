import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoSigner } from '../src/auto-sign.js';
import { haversineMeters } from '../src/locations.js';

// 所有客户端均为内存 mock；此文件没有真实学校账号或网络写接口。
const account = (extra = {}) => ({
  key: 'main', label: '测试主账号', username: '202600000001',
  password: 'fixture-password-only', deviceId: 'fixture-device-only',
  autoAnswer: true, enabled: true, ...extra,
});
const rollcall = (extra = {}) => ({
  id: 101, isRadar: true, active: true, handled: false, expired: false,
  courseTitle: '测试课程', ...extra,
});
const point = (id, lon = 120.1, lat = 30.3) => ({ id, name: `测试点 ${id}`, lon, lat });
const points = [point('preferred'), point('account', 120.11), point('other', 120.12, 30.31)];
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture(t, options = {}) {
  const dataDir = options.dataDir || mkdtempSync(join(tmpdir(), 'rollcall-auto-sign-test-'));
  if (!options.dataDir) t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = { autoAnswer: true, autoDefaultLocation: 'preferred', autoFallback: false, ...options.config };
  const calls = { answer: [], read: [], resolve: [], all: 0, logs: [], changed: 0 };
  let clock = 1_800_000_000_000;
  const locations = {
    resolve: (value) => {
      calls.resolve.push(value);
      if (options.resolve) return options.resolve(value);
      return (options.points || points).find((p) => p.id === value) || null;
    },
    all: () => { calls.all += 1; return options.points || points; },
  };
  const createSigner = () => new AutoSigner(dataDir, {
    getConfig: () => config, locations,
    log: (...args) => calls.logs.push(args),
    changed: () => { calls.changed += 1; }, now: () => clock,
  });
  const signer = createSigner();
  const client = {
    answerRadar: async (id, location) => {
      calls.answer.push({ id, point: { ...location } });
      if (options.answer) return options.answer(id, location, calls.answer.length);
      return { status: 200, json: { status: 'on_call_fine' } };
    },
    rollcalls: async () => {
      calls.read.push(true);
      if (options.read) return options.read(calls.read.length);
      return [rollcall({ active: false, handled: true })];
    },
  };
  return { signer, client, calls, config, dataDir, createSigner, advance: (ms) => { clock += ms; } };
}

function last(signer) {
  const history = signer.history();
  assert.ok(Array.isArray(history));
  assert.ok(history.length > 0, '一次尝试应有公开历史记录');
  return history[0];
}

for (const [name, options, who, rc, canContinue] of [
  ['全局自动开关关闭', { config: { autoAnswer: false } }, account(), rollcall()],
  ['账号未选择参与', {}, account({ autoAnswer: false }), rollcall()],
  ['账号已停用', {}, account({ enabled: false }), rollcall()],
  ['已取消本轮', {}, account(), rollcall(), () => false],
  ['非雷达签到', {}, account(), rollcall({ isRadar: false })],
  ['签到非 active', {}, account(), rollcall({ active: false })],
  ['签到已处理', {}, account(), rollcall({ handled: true })],
  ['签到已过期', {}, account(), rollcall({ expired: true })],
  ['全局及账号均未选位置', { config: { autoDefaultLocation: '' } }, account(), rollcall()],
]) {
  test(`${name}：answerRadar 零写`, async (t) => {
    const { signer, client, calls } = fixture(t, options);
    await signer.run(who, rc, client, canContinue);
    assert.equal(calls.answer.length, 0);
    assert.equal(signer.busy, false);
  });
}

test('位置优先账号覆盖；未覆盖时采用全局位置', async (t) => {
  for (const [override, expected] of [['account', 'account'], ['', 'preferred']]) {
    await t.test(expected, async (t) => {
      const { signer, client, calls } = fixture(t);
      await signer.run(account({ location: override }), rollcall(), client);
      assert.equal(calls.answer.length, 1);
      assert.equal(calls.answer[0].point.lon, points.find((p) => p.id === expected).lon);
      assert.equal(last(signer).state, 'success');
    });
  }
});

test('非法账号位置显式报错，不静默使用全局位置或 fallback', async (t) => {
  const { signer, client, calls } = fixture(t, { config: { autoFallback: true } });
  let thrown;
  let result;
  try { result = await signer.run(account({ location: 'missing-point' }), rollcall(), client); }
  catch (error) { thrown = error; }
  assert.equal(calls.answer.length, 0);
  const evidence = [thrown?.message, JSON.stringify(result), JSON.stringify(signer.history()), JSON.stringify(calls.logs)].join(' ');
  assert.match(evidence, /missing-point|点位|位置/);
  assert.ok(thrown || result?.state === 'failed' || signer.history().some((r) => r.state === 'failed'), '错误必须向调用方或历史记录显式呈现');
});

test('默认每轮仅提交所选点，不因距离错误自动遍历点位', async (t) => {
  const { signer, client, calls } = fixture(t, {
    answer: async () => ({ status: 200, json: { error_code: 'too_far', distance: 600 } }),
    read: async () => [rollcall()],
  });
  await signer.run(account(), rollcall(), client);
  assert.equal(calls.answer.length, 1);
  assert.equal(calls.answer[0].point.lon, points[0].lon);
  assert.equal(last(signer).state, 'failed');
});

for (const status of ['on_call_fine', 'on_call', 'present', 'signed']) {
  test(`HTTP 2xx + 明确状态 ${status} 确认成功`, async (t) => {
    const { signer, client } = fixture(t, {
      answer: async () => ({ status: 200, json: { status } }),
      read: async () => [rollcall()],
    });
    const result = await signer.run(account(), rollcall(), client);
    assert.equal(result.state, 'success');
    assert.equal(last(signer).state, 'success');
  });
}

test('success:true 没有签到状态且读回列表缺席该id时保留 pending', async (t) => {
  const { signer, client, calls } = fixture(t, {
    config: { autoFallback: true },
    answer: async () => ({ status: 200, json: { success: true } }),
    read: async () => [],
  });
  await signer.run(account(), rollcall(), client);
  assert.equal(last(signer).state, 'pending');
  assert.equal(calls.answer.length, 1, '模糊写结果不继续 fallback，避免重复提交');
  assert.ok(calls.read.length > 0);
});

test('success:true 但读回明确 active/myStatus=absent 时为 failed，不伪装已签', async (t) => {
  const { signer, client } = fixture(t, {
    answer: async () => ({ status: 200, json: { success: true } }),
    read: async () => [rollcall({ myStatus: 'absent' })],
  });
  await signer.run(account(), rollcall(), client);
  assert.equal(last(signer).state, 'failed');
});

test('非 2xx 的 JSON 即使声称 signed，也须读回确认而非直接成功', async (t) => {
  const { signer, client, calls } = fixture(t, {
    answer: async () => ({ status: 503, json: { status: 'signed' } }),
    read: async () => [rollcall()],
  });
  await signer.run(account(), rollcall(), client);
  assert.notEqual(last(signer).state, 'success');
  assert.ok(calls.read.length > 0);
});

test('失败响应但读回 handled=true 时确认为 success', async (t) => {
  const { signer, client } = fixture(t, {
    answer: async () => ({ status: 500, json: { error_code: 'mock-error' } }),
  });
  await signer.run(account(), rollcall(), client);
  assert.equal(last(signer).state, 'success');
});

test('传输异常但读回 handled=true 仍确认 success', async (t) => {
  const { signer, client } = fixture(t, { answer: async () => { throw new Error('fixture transport failed'); } });
  await signer.run(account(), rollcall(), client);
  assert.equal(last(signer).state, 'success');
});

test('传输异常且读回失败保留 pending，单轮不盲目 fallback', async (t) => {
  const { signer, client, calls } = fixture(t, {
    config: { autoFallback: true },
    answer: async () => { throw new Error('fixture transport failed'); },
    read: async () => { throw new Error('fixture readback failed'); },
  });
  await signer.run(account(), rollcall(), client);
  assert.equal(last(signer).state, 'pending');
  assert.equal(calls.answer.length, 1);
  assert.equal(signer.busy, false);
});

test('失败轮次限额为两轮，间隔至少60秒，同轮不重复写', async (t) => {
  const { signer, client, calls, advance } = fixture(t, {
    answer: async () => ({ status: 200, json: { error_code: 'too_far', distance: 500 } }),
    read: async () => [rollcall()],
  });
  await signer.run(account(), rollcall(), client);
  await signer.run(account(), rollcall(), client);
  assert.equal(calls.answer.length, 1);
  advance(59_999);
  await signer.run(account(), rollcall(), client);
  assert.equal(calls.answer.length, 1);
  advance(1);
  signer.observe(account(), [rollcall()]);
  await signer.run(account(), rollcall(), client);
  assert.equal(calls.answer.length, 2);
  advance(120_000);
  signer.observe(account(), [rollcall()]);
  await signer.run(account(), rollcall(), client);
  assert.equal(calls.answer.length, 2);
});

test('pending 下轮读回失败时继续零写，查到 active 后才按间隔重试', async (t) => {
  let readsFail = true;
  const { signer, client, calls, advance } = fixture(t, {
    answer: async () => { throw new Error('fixture lost response'); },
    read: async () => {
      if (readsFail) throw new Error('fixture read unavailable');
      return [rollcall()];
    },
  });
  await signer.run(account(), rollcall(), client);
  advance(60_000);
  await signer.run(account(), rollcall(), client);
  assert.equal(calls.answer.length, 1, '尚未得到可信的 active 回读，保持 pending');
  readsFail = false;
  signer.observe(account(), [rollcall()]);
  await signer.run(account(), rollcall(), client);
  assert.equal(calls.answer.length, 2);
});

for (const initial of ['pending', 'failed']) {
  test(`observe 将 ${initial} 回读 handled 晋升 success，且隔离其他账号`, async (t) => {
    const { signer, client } = fixture(t, {
      answer: async () => ({ status: 200, json: initial === 'pending' ? { success: true } : { error_code: 'too_far' } }),
      read: async () => initial === 'pending' ? [] : [rollcall()],
    });
    await signer.run(account(), rollcall(), client);
    assert.equal(last(signer).state, initial);
    signer.observe(account({ key: 'a2', username: '202600000002' }), [rollcall({ active: false, handled: true })]);
    assert.equal(last(signer).state, initial);
    assert.equal(signer.observe(account(), [rollcall({ active: false, handled: true })]) instanceof Promise, false, 'observe 为同步接口');
    assert.equal(last(signer).state, 'success');
  });
}

test('success 持久去重：重启、相同账号重复签到零写，不同账号 namespace 独立', async (t) => {
  const { signer, client, calls, createSigner } = fixture(t);
  await signer.run(account(), rollcall(), client);
  await signer.run(account(), rollcall(), client);
  const restarted = createSigner();
  await restarted.run(account(), rollcall(), client);
  assert.equal(calls.answer.length, 1);
  await restarted.run(account({ key: 'a2', username: '202600000002' }), rollcall(), client);
  assert.equal(calls.answer.length, 2);
  assert.equal(restarted.history().filter((r) => r.state === 'success').length, 2);
});

test('fallback 显式打开时按所选点及其它点遍历，总尝试最多20次', async (t) => {
  const many = Array.from({ length: 25 }, (_, index) => point(index === 0 ? 'preferred' : `p${index}`, 120 + index * 0.001, 30));
  const { signer, client, calls } = fixture(t, {
    points: many, config: { autoFallback: true },
    answer: async () => ({ status: 200, json: { error_code: 'too_far', distance: 600 } }),
    read: async () => [rollcall()],
  });
  await signer.run(account(), rollcall(), client);
  assert.equal(calls.answer[0].point.lon, many[0].lon);
  assert.equal(calls.answer.length, 20);
  assert.equal(new Set(calls.answer.map((c) => `${c.point.lon},${c.point.lat}`)).size, 20, '不要重复尝试相同坐标');
});

test('fallback 可使用可靠距离定位，且坐标精度足以接近目标', async (t) => {
  const anchors = [point('preferred', 120, 30), point('east', 121, 30), point('north', 120, 31)];
  const target = { lon: 120.3, lat: 30.4 };
  const { signer, client, calls } = fixture(t, {
    points: anchors, config: { autoFallback: true },
    answer: async (_id, p) => haversineMeters(p, target) < 10
      ? { status: 200, json: { status: 'present' } }
      : { status: 200, json: { error_code: 'too_far', distance: haversineMeters(p, target) } },
    read: async () => [rollcall()],
  });
  await signer.run(account(), rollcall(), client);
  assert.ok(calls.answer.length > anchors.length, '可靠的三点距离后应尝试推算坐标');
  assert.ok(calls.answer.some((c) => haversineMeters(c.point, target) < 10));
  assert.equal(last(signer).state, 'success');
  assert.ok(calls.answer.length <= 20);
});

for (const mode of ['config', 'canContinue', 'account', 'fallback', 'location']) {
  test(`首次写后 ${mode} 关闭，逐次检查并停止 fallback`, async (t) => {
    let allowed = true;
    const who = account();
    let f;
    f = fixture(t, {
      config: { autoFallback: true },
      answer: async () => {
        if (mode === 'config') f.config.autoAnswer = false;
        if (mode === 'fallback') f.config.autoFallback = false;
        if (mode === 'location') f.config.autoDefaultLocation = 'other';
        if (mode === 'account') who.autoAnswer = false;
        if (mode === 'canContinue') allowed = false;
        return { status: 200, json: { error_code: 'too_far', distance: 600 } };
      },
      read: async () => [rollcall()],
    });
    await f.signer.run(who, rollcall(), f.client, () => allowed);
    assert.equal(f.calls.answer.length, 1);
    assert.equal(f.signer.busy, false);
  });
}

test('busy 在进行中可见，重入不重复写，完成后复原', { timeout: 3000 }, async (t) => {
  const entered = deferred();
  const gate = deferred();
  const { signer, client, calls } = fixture(t, {
    answer: async () => { entered.resolve(); await gate.promise; return { status: 200, json: { status: 'signed' } }; },
  });
  const first = signer.run(account(), rollcall(), client);
  try {
    await entered.promise;
    assert.equal(signer.busy, true);
    const concurrent = signer.run(account(), rollcall(), client);
    assert.strictEqual(concurrent, first, '相同账号/点名共享进行中的 Promise');
    assert.equal(calls.answer.length, 1);
  } finally { gate.resolve(); }
  await first;
  assert.equal(signer.busy, false);
});

test('损坏的历史触发storageError并阻止写请求，原文件字节保持不变', async (t) => {
  const { dataDir, client, calls, createSigner } = fixture(t);
  const historyFile = join(dataDir, 'auto-sign.json');
  const invalidHistory = '{broken auto-sign history\r\n  original fixture bytes';
  writeFileSync(historyFile, invalidHistory, 'utf8');
  const before = readFileSync(historyFile);
  const signer = createSigner();
  assert.equal(typeof signer.storageError, 'string');
  assert.ok(signer.storageError.length > 0);
  const result = await signer.run(account(), rollcall(), client);
  assert.equal(result.state, 'failed');
  assert.equal(result.message, signer.storageError);
  assert.equal(calls.answer.length, 0);
  assert.equal(signer.busy, false);
  assert.deepEqual(readFileSync(historyFile), before, '错误处理保留原损坏文件，避免覆盖去重依据');
  const restarted = createSigner();
  assert.ok(restarted.storageError.length > 0, '重启后损坏历史仍可诊断');
  await restarted.run(account(), rollcall(), client);
  assert.equal(calls.answer.length, 0);
  assert.deepEqual(readFileSync(historyFile), before);
});

test('公开 history 不包含 username/password/deviceId 内部字段或原值', async (t) => {
  const { signer, client } = fixture(t);
  const who = account();
  await signer.run(who, rollcall(), client);
  assert.ok(signer.records instanceof Map);
  const publicHistory = signer.history();
  const serialized = JSON.stringify(publicHistory);
  for (const value of [who.username, who.password, who.deviceId]) assert.equal(serialized.includes(value), false);
  const checkKeys = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      assert.ok(!['username', 'password', 'deviceId'].includes(key), `公开历史泄露内部字段 ${key}`);
      checkKeys(nested);
    }
  };
  checkKeys(publicHistory);
});
