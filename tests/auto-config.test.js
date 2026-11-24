import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountsFile, parseEnvFile, resolveAccounts, saveAccount } from '../src/accounts.js';
import { ConfigStore, DEFAULTS, normalizeConfig } from '../src/config.js';
import { CoursesClient } from '../src/courses.js';

function temporary(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'rollcall-auto-config-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}
function isolatedAccounts(t) {
  const dataDir = temporary(t);
  // 空独立文件阻止读取环境变量或任何外部真实凭据。
  writeFileSync(join(dataDir, 'accounts.json'), '[]');
  return dataDir;
}
const credentials = { username: '202600000001', password: 'auto-config-fixture-only' };
const autoFields = (config) => ({
  autoAnswer: config.autoAnswer, autoDefaultLocation: config.autoDefaultLocation,
  autoFallback: config.autoFallback,
});
function mockClient() {
  const calls = [];
  const response = { status: 200, json: { status: 'signed' } };
  const client = new CoursesClient({ fixtureOnly: true });
  // 直接截获 json 调用；不调用 request，不使用网络。
  client.json = async (path, options) => { calls.push({ path, options }); return response; };
  return { client, calls, response };
}

test('saveAccount 新增账号保存 autoAnswer/location 到本地 accounts.env，读回与磁盘一致', (t) => {
  const dataDir = isolatedAccounts(t);
  const result = saveAccount(dataDir, { ...credentials, autoAnswer: false, location: '  测试点位  ' });
  assert.equal(result.ok, true);
  assert.equal(result.key, 'main');
  const saved = resolveAccounts(dataDir).accounts[0];
  assert.equal(saved.autoAnswer, false);
  assert.equal(saved.location, '测试点位');
  const disk = parseEnvFile(accountsFile(dataDir));
  assert.equal(disk.ZJU_AUTO_ANSWER, 'false');
  assert.equal(disk.ZJU_LOCATION, '测试点位');
  saveAccount(dataDir, { key: 'main', autoAnswer: true, location: '新点位' });
  assert.equal(resolveAccounts(dataDir).accounts[0].autoAnswer, true);
  assert.equal(resolveAccounts(dataDir).accounts[0].location, '新点位');
});

test('编辑其他字段时保留 autoAnswer=false/location，空location显式清除', (t) => {
  const dataDir = isolatedAccounts(t);
  saveAccount(dataDir, { ...credentials, autoAnswer: false, location: '测试点位' });
  saveAccount(dataDir, { key: 'main', label: '仅更名' });
  let saved = resolveAccounts(dataDir).accounts[0];
  assert.equal(saved.autoAnswer, false);
  assert.equal(saved.location, '测试点位');
  assert.equal(saved.username, credentials.username);
  assert.equal(saved.password, credentials.password);
  saveAccount(dataDir, { key: 'main', location: '' });
  saved = resolveAccounts(dataDir).accounts[0];
  assert.equal(saved.location, '');
  assert.equal(saved.autoAnswer, false);
});

test('旧账号缺省autoAnswer默认参与，未提供location保持空字符串', (t) => {
  const dataDir = isolatedAccounts(t);
  saveAccount(dataDir, credentials);
  const saved = resolveAccounts(dataDir).accounts[0];
  assert.equal(saved.autoAnswer, true);
  assert.equal(saved.location, '');
});

test('ConfigStore 缺省总开关/fallback关闭且无默认点位', (t) => {
  const dataDir = temporary(t);
  const expected = { autoAnswer: false, autoDefaultLocation: '', autoFallback: false };
  assert.deepEqual(autoFields(DEFAULTS), expected);
  assert.deepEqual(autoFields(normalizeConfig()), expected);
  assert.deepEqual(autoFields(new ConfigStore(dataDir).load()), expected);
});

test('normalizeConfig 两开关仅接受true，位置去首尾空白并限长120', () => {
  for (const value of [false, undefined, null, 0, 1, 'true', 'false', {}, []]) {
    const normalized = normalizeConfig({ autoAnswer: value, autoFallback: value });
    assert.equal(normalized.autoAnswer, false);
    assert.equal(normalized.autoFallback, false);
  }
  assert.deepEqual(autoFields(normalizeConfig({ autoAnswer: true, autoFallback: true, autoDefaultLocation: '  测试点位  ' })), {
    autoAnswer: true, autoDefaultLocation: '测试点位', autoFallback: true,
  });
  assert.equal(normalizeConfig({ autoDefaultLocation: 'x'.repeat(130) }).autoDefaultLocation, 'x'.repeat(120));
  assert.equal(normalizeConfig({ autoDefaultLocation: null }).autoDefaultLocation, '');
});

test('ConfigStore.patch 持久保存三字段，跨实例回读，局部修改保留未改字段', (t) => {
  const dataDir = temporary(t);
  const store = new ConfigStore(dataDir);
  const expected = { autoAnswer: true, autoDefaultLocation: '测试点位', autoFallback: true };
  const patched = store.patch({ autoAnswer: true, autoDefaultLocation: ' 测试点位 ', autoFallback: true });
  assert.deepEqual(autoFields(patched), expected);
  const persisted = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  assert.deepEqual(autoFields(persisted), expected);
  assert.deepEqual(autoFields(new ConfigStore(dataDir).load()), expected);
  const next = new ConfigStore(dataDir);
  next.patch({ autoAnswer: false });
  assert.deepEqual(autoFields(new ConfigStore(dataDir).load()), { ...expected, autoAnswer: false });
  next.patch({ autoDefaultLocation: '', autoFallback: false });
  assert.deepEqual(autoFields(new ConfigStore(dataDir).load()), { autoAnswer: false, autoDefaultLocation: '', autoFallback: false });
});

test('CoursesClient.answerRadar 编码id并序列化规范PUT payload，传入deviceId被保留', async () => {
  const { client, calls, response } = mockClient();
  const result = await client.answerRadar('101/教室 ?#&', {
    lon: '120.123456', lat: '30.123456', deviceId: 'fixture-device',
    username: 'must-not-serialize', password: 'must-not-serialize',
  });
  assert.strictEqual(result, response);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    path: '/api/rollcall/101%2F%E6%95%99%E5%AE%A4%20%3F%23%26/answer?api_version=1.1.2',
    options: { method: 'PUT', body: {
      deviceId: 'fixture-device', latitude: 30.123456, longitude: 120.123456,
      accuracy: 68, speed: null, altitude: null, altitudeAccuracy: null, heading: null,
    } },
  });
  const serialized = JSON.parse(JSON.stringify(calls[0].options.body));
  assert.equal(typeof serialized.longitude, 'number');
  assert.equal(typeof serialized.latitude, 'number');
  assert.equal('password' in serialized, false);
  assert.equal('username' in serialized, false);
});

test('CoursesClient.answerRadar 缺省deviceId生成UUID，边界经纬度可序列化', async () => {
  const { client, calls } = mockClient();
  await client.answerRadar(101, { lon: 180, lat: 90 });
  await client.answerRadar(102, { lon: -180, lat: -90 });
  assert.equal(calls.length, 2);
  for (const call of calls) assert.match(call.options.body.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(calls[0].options.body.deviceId, calls[1].options.body.deviceId);
});

test('CoursesClient.answerRadar 非法坐标/缺少id均在json调用前报错，零写', async (t) => {
  const cases = [
    ['缺少经纬度', 101, undefined],
    ['经度超界', 101, { lon: 180.000001, lat: 30 }],
    ['纬度超界', 101, { lon: 120, lat: -90.000001 }],
    ['经度NaN', 101, { lon: NaN, lat: 30 }],
    ['纬度Infinity', 101, { lon: 120, lat: Infinity }],
    ['非数字字符串', 101, { lon: 'invalid', lat: 30 }],
    ['缺少id', undefined, { lon: 120, lat: 30 }],
    ['null id', null, { lon: 120, lat: 30 }],
    ['空id', '  ', { lon: 120, lat: 30 }],
  ];
  for (const [name, id, point] of cases) {
    await t.test(name, async () => {
      const { client, calls } = mockClient();
      await assert.rejects(client.answerRadar(id, point), /签到编号|经纬度/);
      assert.equal(calls.length, 0);
    });
  }
});
