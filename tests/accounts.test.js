import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accountsFile, accountsFromEnv, candidateCredentialFiles, deleteAccount,
  ensureAccountsTemplate, formatEnvValue, maskAccount, parseEnvFile, parseEnvText,
  resolveAccounts, saveAccount, serializeAccountsEnv,
} from '../src/accounts.js';

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'rollcall-accounts-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const main = (extra = {}) => ({
  key: 'main', username: '202600000001', password: 'fixture-password-#=only',
  label: '测试账号', enabled: true, autoAnswer: true, location: '测试教室', primary: true, ...extra,
});

function isolateCredentialEnvironment(t) {
  const names = [...new Set([
    'ROLLCALL_ENV_FILE', 'PORTABLE_EXECUTABLE_DIR',
    ...Object.keys(process.env).filter((name) => /^ZJU_(USER|USERNAME|PASSWORD|PASS|LABEL|LOCATION|ENABLED|AUTO_ANSWER)(?:_\d+)?$/.test(name)),
  ])];
  const original = new Map(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const name of names) delete process.env[name];
}

test('parseEnvText 支持 CRLF/LF、多账号、引号、转义、行内注释及密码内 #/= 字符', () => {
  const parsed = parseEnvText([
    '# fixture only',
    'ZJU_USER=202600000001',
    'ZJU_PASSWORD="fake #secret=\\"\\\\"',
    '',
    'ZJU_USER_2=202600000002 # another account',
    "ZJU_PASSWORD_2='second #secret=1'",
    'ZJU_LABEL_2=测试副账号',
    'ZJU_ENABLED_2=false',
    'ZJU_AUTO_ANSWER_2=false',
  ].join('\r\n'));
  assert.equal(parsed.ZJU_USER, '202600000001');
  assert.equal(parsed.ZJU_PASSWORD, 'fake #secret="\\');
  assert.equal(parsed.ZJU_USER_2, '202600000002');
  assert.equal(parsed.ZJU_PASSWORD_2, 'second #secret=1');
  assert.equal(parsed.ZJU_ENABLED_2, 'false');
  assert.equal(parsed.ZJU_AUTO_ANSWER_2, 'false');
  assert.deepEqual(parseEnvText('export A=1\nB=2\n'), { A: '1', B: '2' });
});

test('formatEnvValue 与 serializeAccountsEnv 往返保留特殊密码字符与字段', () => {
  const weirdPassword = 'p@ss #1 = "quote" \'single\' \\end';
  assert.equal(parseEnvText(`X=${formatEnvValue(weirdPassword)}`).X, weirdPassword);
  const envText = serializeAccountsEnv([
    main({ password: weirdPassword, autoAnswer: false, location: '120.089136,30.302331' }),
    main({ key: 'a2', username: '202600000002', password: 'plainPassword123', label: '副账号 2', enabled: false, autoAnswer: true, location: '' }),
  ]);
  const roundTripped = accountsFromEnv(parseEnvText(envText));
  assert.equal(roundTripped.length, 2);
  assert.equal(roundTripped[0].password, weirdPassword);
  assert.equal(roundTripped[0].autoAnswer, false);
  assert.equal(roundTripped[0].location, '120.089136,30.302331');
  assert.equal(roundTripped[1].key, 'a2');
  assert.equal(roundTripped[1].label, '副账号 2');
  assert.equal(roundTripped[1].enabled, false);
  assert.equal(roundTripped[1].autoAnswer, true);
});

test('accountsFromEnv 支持 main/a2 别名、disabled/autoAnswer，忽略残缺凭据', () => {
  const accounts = accountsFromEnv({
    ZJU_USERNAME: '202600000001', ZJU_PASS: 'first-test-password',
    ZJU_USER_2: '202600000002', ZJU_PASSWORD_2: 'second-test-password',
    ZJU_LABEL_2: '副账号', ZJU_LOCATION_2: '测试教室', ZJU_ENABLED_2: 'off', ZJU_AUTO_ANSWER_2: '0',
    ZJU_USER_3: '202600000003',
  });
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].key, 'main');
  assert.equal(accounts[0].primary, true);
  assert.equal(accounts[0].autoAnswer, true);
  assert.equal(accounts[1].key, 'a2');
  assert.equal(accounts[1].enabled, false);
  assert.equal(accounts[1].autoAnswer, false);
  assert.equal(accounts[1].label, '副账号');
  assert.equal(accounts[1].location, '测试教室');
});

test('resolveAccounts 优先读取本地 accounts.env，兼容旧 accounts.json 且损坏时显式报错', (t) => {
  isolateCredentialEnvironment(t);
  const root = temporary(t);
  writeFileSync(join(root, 'accounts.json'), JSON.stringify([main()]));
  let result = resolveAccounts(root);
  assert.equal(result.source, join(root, 'accounts.json'));
  assert.equal(result.accounts.length, 1);

  writeFileSync(accountsFile(root), serializeAccountsEnv([main({ label: '来自ENV' })]));
  result = resolveAccounts(root);
  assert.equal(result.source, accountsFile(root));
  assert.equal(result.accounts[0].label, '来自ENV');

  const brokenDir = temporary(t);
  for (const contents of ['{broken', '{"accounts":[]}']) {
    writeFileSync(join(brokenDir, 'accounts.json'), contents);
    assert.throws(() => resolveAccounts(brokenDir));
  }
});

test('ensureAccountsTemplate 只创建模板，不覆盖已有文件', (t) => {
  const root = temporary(t);
  const first = ensureAccountsTemplate(root);
  assert.equal(first.created, true);
  assert.equal(first.path, accountsFile(root));
  writeFileSync(first.path, '# fixture sentinel\n');
  assert.equal(ensureAccountsTemplate(root).created, false);
  assert.equal(readFileSync(first.path, 'utf8'), '# fixture sentinel\n');
});

test('saveAccount 保存到本地 accounts.env，编辑时留空学号/密码保留原值且返回不泄露密码', (t) => {
  isolateCredentialEnvironment(t);
  const root = temporary(t);
  const before = main();
  const created = saveAccount(root, before);
  assert.equal(created.ok, true);
  assert.equal(created.key, 'main');
  assert.equal(created.file, accountsFile(root));
  assert.equal(existsSync(accountsFile(root)), true);

  const edited = saveAccount(root, { key: 'main', username: '', password: '', label: '更名账号' });
  assert.equal(edited.ok, true);
  assert.equal(edited.key, 'main');
  assert.equal(JSON.stringify(edited).includes(before.password), false);

  const resolved = resolveAccounts(root);
  assert.equal(resolved.source, accountsFile(root));
  assert.equal(resolved.accounts.length, 1);
  assert.equal(resolved.accounts[0].username, before.username);
  assert.equal(resolved.accounts[0].password, before.password);
  assert.equal(resolved.accounts[0].label, '更名账号');
  assert.equal(resolved.accounts[0].location, before.location);
});

test('saveAccount 修改一个账号不影响其他账号，且从旧 accounts.json 迁移到 accounts.env', (t) => {
  isolateCredentialEnvironment(t);
  const root = temporary(t);
  const second = main({ key: 'a2', username: '202600000002', password: 'second-test-only', enabled: false, primary: false });
  writeFileSync(join(root, 'accounts.json'), JSON.stringify([main(), second]));
  saveAccount(root, { key: 'main', username: '', password: 'replacement-test-only' });
  assert.equal(existsSync(accountsFile(root)), true);
  assert.equal(existsSync(join(root, 'accounts.json')), false);
  const accounts = resolveAccounts(root).accounts;
  assert.equal(accounts[0].password, 'replacement-test-only');
  assert.deepEqual(accounts[1], second);
});

test('candidateCredentialFiles 仅返回本地 accounts.env 与显式指定的 .env 路径', (t) => {
  isolateCredentialEnvironment(t);
  const root = temporary(t);
  const external = join(root, 'custom.env');
  writeFileSync(external, 'ZJU_USER=202600000001\nZJU_PASSWORD=custom-fixture\n');
  const files = candidateCredentialFiles(root, [external]);
  assert.deepEqual(files, [accountsFile(root), external]);
  const resolved = resolveAccounts(root, { extraFiles: [external] });
  assert.equal(resolved.source, external);
  assert.equal(resolved.accounts[0].username, '202600000001');
});

test('saveAccount 与 deleteAccount 正确管理主副账号与本地 accounts.env', (t) => {
  isolateCredentialEnvironment(t);
  const root = temporary(t);
  assert.equal(saveAccount(root, { username: '202600000001', password: 'first-fixture' }).key, 'main');
  assert.equal(saveAccount(root, { username: '202600000002', password: 'second-fixture' }).key, 'a2');
  assert.deepEqual(resolveAccounts(root).accounts.map((item) => item.key), ['main', 'a2']);

  const deleted = deleteAccount(root, 'a2');
  assert.equal(deleted.ok, true);
  assert.equal(deleted.remaining, 1);
  assert.deepEqual(resolveAccounts(root).accounts.map((item) => item.key), ['main']);
  assert.equal(parseEnvFile(accountsFile(root)).ZJU_USER_2, undefined);

  deleteAccount(root, 'main');
  assert.deepEqual(resolveAccounts(root).accounts, []);
  assert.throws(() => deleteAccount(root, 'main'), /未找到/);
});

test('saveAccount 非数字学号及新账号空密码被校验，磁盘 accounts.env 保持不变', (t) => {
  isolateCredentialEnvironment(t);
  const root = temporary(t);
  saveAccount(root, main());
  const file = accountsFile(root);
  const before = readFileSync(file, 'utf8');
  assert.throws(() => saveAccount(root, { key: 'main', username: 'not-a-number', password: 'fixture' }), /学号/);
  assert.throws(() => saveAccount(root, { key: 'a2', username: '202600000002', password: '' }), /密码/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('maskAccount 不返回完整学号，公共展示对象不泄露密码', () => {
  const raw = main();
  const masked = maskAccount(raw.username);
  assert.equal(masked, '202***01');
  assert.notEqual(masked, raw.username);
  assert.equal(maskAccount('12345'), '1***');
  assert.equal(maskAccount('1'), '1***');
  assert.equal(maskAccount(''), '');
  assert.equal(maskAccount(null), '');
  const publicRecord = { key: raw.key, username: maskAccount(raw.username), label: raw.label };
  const serialized = JSON.stringify(publicRecord);
  assert.equal(serialized.includes(raw.password), false);
  assert.equal(serialized.includes(raw.username), false);
});
