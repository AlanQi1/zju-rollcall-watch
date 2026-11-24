/**
 * 本地账号配置：统一读写本地 accounts.env（标准 .env 格式）。
 *
 * 支持多账号：
 *   ZJU_USER / ZJU_PASSWORD / ZJU_LABEL / ZJU_LOCATION / ZJU_ENABLED / ZJU_AUTO_ANSWER
 *   ZJU_USER_2 / ZJU_PASSWORD_2 / ZJU_LABEL_2 / ZJU_LOCATION_2 / ZJU_ENABLED_2 / ZJU_AUTO_ANSWER_2
 *
 * 密码仅留在本地 .env 与登录内存请求中，不写日志、不暴露到渲染层，对外只返回脱敏学号。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 解析 .env 文本，正确处理引号、转义字符、行内注释与密码中的 #/= 符号。 */
export function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!key) continue;
    const rawValue = line.slice(eq + 1).trim();
    out[key] = parseEnvValue(rawValue);
  }
  return out;
}

function parseEnvValue(raw) {
  if (!raw) return '';
  if (raw.startsWith('"')) {
    let result = '';
    for (let i = 1; i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch === '\\' && i + 1 < raw.length) {
        const next = raw[i + 1];
        if (next === 'n') result += '\n';
        else if (next === 'r') result += '\r';
        else if (next === 't') result += '\t';
        else result += next;
        i += 1;
        continue;
      }
      if (ch === '"') return result;
      result += ch;
    }
    return result;
  }
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1);
    return end >= 0 ? raw.slice(1, end) : raw.slice(1);
  }
  const hash = raw.search(/\s#/);
  return (hash > 0 ? raw.slice(0, hash) : raw).trim();
}

/** 将值安全序列化为 .env 值，含特殊字符时自动双引号包裹并转义。 */
export function formatEnvValue(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (/[\s#"'\r\n\\=$;`]/.test(text)) {
    const escaped = text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n');
    return `"${escaped}"`;
  }
  return text;
}

export function parseEnvFile(path) {
  try {
    return parseEnvText(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

const KEY_RE = /^ZJU_(USER|USERNAME|PASSWORD|PASS|LABEL|LOCATION|ENABLED|AUTO_ANSWER)(?:_(\d+))?$/;

function suffixToKey(index) {
  const n = Number(index);
  if (!n || n <= 1) return 'main';
  return `a${n}`;
}

function keyToSuffix(key) {
  if (key === 'main') return '';
  const match = /^a(\d+)$/.exec(String(key || ''));
  return match ? `_${match[1]}` : '';
}

function parseBool(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function makeAccount(raw) {
  const username = String(raw.username || '').trim();
  const password = String(raw.password || '');
  const key = String(raw.key || 'main').trim() || 'main';
  if (!username || !password) return null;
  return {
    key,
    label: String(raw.label || '').trim() || (key === 'main' ? '主账号' : key),
    username,
    password,
    location: String(raw.location || '').trim().slice(0, 120),
    autoAnswer: raw.autoAnswer !== false,
    enabled: raw.enabled !== false,
    primary: key === 'main',
  };
}

function sortAccounts(list) {
  return [...list].sort((a, b) => {
    if (a.key === 'main') return -1;
    if (b.key === 'main') return 1;
    return a.key.localeCompare(b.key, 'en', { numeric: true });
  });
}

/** 从一张 KEY=VALUE 表里抽出所有有效账号。 */
export function accountsFromEnv(parsed) {
  const byKey = new Map();
  for (const [name, value] of Object.entries(parsed || {})) {
    const matched = KEY_RE.exec(name);
    if (!matched) continue;
    const field = matched[1];
    const key = suffixToKey(matched[2]);
    if (!byKey.has(key)) {
      byKey.set(key, { key, username: '', password: '', label: '', location: '', enabled: true, autoAnswer: true });
    }
    const entry = byKey.get(key);
    if (field === 'USER' || field === 'USERNAME') entry.username = value;
    else if (field === 'PASSWORD' || field === 'PASS') entry.password = value;
    else if (field === 'LABEL') entry.label = value;
    else if (field === 'LOCATION') entry.location = value;
    else if (field === 'ENABLED') entry.enabled = parseBool(value, true);
    else if (field === 'AUTO_ANSWER') entry.autoAnswer = parseBool(value, true);
  }
  const out = [];
  for (const entry of byKey.values()) {
    const account = makeAccount(entry);
    if (account) out.push(account);
  }
  return sortAccounts(out);
}

/** 将账号列表序列化为标准 .env 文件文本。 */
export function serializeAccountsEnv(accounts) {
  const sorted = sortAccounts((accounts || []).map(makeAccount).filter(Boolean));
  const lines = [
    '# ===== 签到雷达 · 本地账号配置 (accounts.env) =====',
    '# 账号密码仅保存在本机，请勿将此文件上传到公开仓库或分享给他人。',
    '# 可在程序内「账号」页面直接添加、编辑或删除，也可手动修改本文件。',
    '',
  ];
  if (!sorted.length) {
    lines.push(
      '# ZJU_USER=你的学号',
      '# ZJU_PASSWORD=你的密码',
      '# ZJU_LABEL=主账号',
      '# ZJU_LOCATION=',
      '# ZJU_ENABLED=true',
      '# ZJU_AUTO_ANSWER=true',
      '',
    );
    return lines.join('\n');
  }
  sorted.forEach((account, index) => {
    const suffix = keyToSuffix(account.key);
    lines.push(`# 账号 ${index + 1} (${account.key})`);
    lines.push(`ZJU_USER${suffix}=${formatEnvValue(account.username)}`);
    lines.push(`ZJU_PASSWORD${suffix}=${formatEnvValue(account.password)}`);
    lines.push(`ZJU_LABEL${suffix}=${formatEnvValue(account.label)}`);
    lines.push(`ZJU_LOCATION${suffix}=${formatEnvValue(account.location)}`);
    lines.push(`ZJU_ENABLED${suffix}=${account.enabled ? 'true' : 'false'}`);
    lines.push(`ZJU_AUTO_ANSWER${suffix}=${account.autoAnswer ? 'true' : 'false'}`);
    lines.push('');
  });
  return lines.join('\n');
}

/** 学号脱敏：保留前 3 位与后 2 位。 */
export function maskAccount(username) {
  const value = String(username || '');
  if (value.length <= 5) return value ? `${value[0]}***` : '';
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

const TEMPLATE = `# ===== 签到雷达 · 本地账号配置 (accounts.env) =====
# 账号密码仅保存在本机，请勿将此文件上传到公开仓库或分享给他人。
# 推荐直接在程序内「账号 → 添加账号」录入，也可按下方格式手动填写：
# ZJU_USER=你的学号
# ZJU_PASSWORD=你的密码
# ZJU_LABEL=主账号
# ZJU_LOCATION=东一教学楼
# ZJU_ENABLED=true
# ZJU_AUTO_ANSWER=true
#
# 多个账号使用 _2 / _3 后缀：
# ZJU_USER_2=
# ZJU_PASSWORD_2=
# ZJU_LABEL_2=账号2
`;

/** 本地 .env 账号文件路径。 */
export function accountsFile(dataDir) {
  return join(dataDir, 'accounts.env');
}

/** 首次运行生成空模板（不覆盖已有文件）。 */
export function ensureAccountsTemplate(dataDir) {
  const file = accountsFile(dataDir);
  try {
    if (existsSync(file)) return { path: file, created: false };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, TEMPLATE, { encoding: 'utf8', mode: 0o600 });
    return { path: file, created: true };
  } catch {
    return { path: file, created: false };
  }
}

/** 本地 .env 候选路径（优先应用数据目录，其次显式指定的本地 .env）。 */
export function candidateCredentialFiles(dataDir, extraFiles = []) {
  const list = [accountsFile(dataDir)];
  if (process.env.ROLLCALL_ENV_FILE) list.push(process.env.ROLLCALL_ENV_FILE);
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    list.push(join(process.env.PORTABLE_EXECUTABLE_DIR, 'accounts.env'));
    list.push(join(process.env.PORTABLE_EXECUTABLE_DIR, '.env'));
  }
  for (const extra of extraFiles || []) {
    if (extra) list.push(extra);
  }
  return [...new Set(list)];
}

function writeAccountsEnv(dataDir, accounts) {
  const file = accountsFile(dataDir);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${file}.tmp`, serializeAccountsEnv(accounts), { encoding: 'utf8', mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  const legacyJson = join(dataDir, 'accounts.json');
  if (existsSync(legacyJson)) {
    try { rmSync(legacyJson, { force: true }); } catch { /* 忽略清理失败 */ }
  }
  return file;
}

/**
 * 解析全部账号。
 * 优先级：
 *   1. dataDir/accounts.env（程序内保存的标准本地 .env）
 *   2. dataDir/accounts.json（兼容旧版本配置）
 *   3. 其它本地候选 .env（如 ROLLCALL_ENV_FILE 或便携程序同目录 .env）
 *   4. 进程环境变量 ZJU_USER / ZJU_PASSWORD
 */
export function resolveAccounts(dataDir, options = {}) {
  const primaryEnv = accountsFile(dataDir);
  if (existsSync(primaryEnv)) {
    const list = accountsFromEnv(parseEnvFile(primaryEnv));
    if (list.length > 0) return { accounts: list, source: primaryEnv };
  }

  const legacyJson = join(dataDir, 'accounts.json');
  if (existsSync(legacyJson)) {
    const raw = JSON.parse(readFileSync(legacyJson, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('独立账号文件格式错误');
    return { accounts: sortAccounts(raw.map(makeAccount).filter(Boolean)), source: legacyJson };
  }

  for (const path of candidateCredentialFiles(dataDir, options.extraFiles)) {
    if (path === primaryEnv) continue;
    if (existsSync(path)) {
      const accs = accountsFromEnv(parseEnvFile(path));
      if (accs.length > 0) return { accounts: accs, source: path };
    }
  }

  const fromProcessEnv = accountsFromEnv(process.env);
  if (fromProcessEnv.length > 0) {
    return { accounts: fromProcessEnv, source: 'env' };
  }

  return { accounts: [], source: null };
}

/** 新增或更新账号并写入本地 accounts.env。编辑时留空学号或密码表示保留原值。 */
export function saveAccount(dataDir, input, options = {}) {
  if (!input || typeof input !== 'object') throw new Error('请填写账号信息');
  const current = resolveAccounts(dataDir, options).accounts;
  const key = input.key
    ? String(input.key)
    : (!current.some((a) => a.key === 'main')
        ? 'main'
        : `a${Math.max(1, ...current.map((a) => Number(a.key.slice(1)) || 1)) + 1}`);
  if (!/^(main|a\d+)$/.test(key)) throw new Error('账号标识格式错误');
  const index = current.findIndex((a) => a.key === key);
  const previous = index >= 0 ? current[index] : {};
  const username = String(input.username || previous.username || '').trim();
  const password = String(input.password || previous.password || '');
  if (!/^\d{6,20}$/.test(username)) throw new Error('请填写完整的数字学号（6–20位）');
  if (!password || password.length > 256) throw new Error('请填写密码（1–256位）');
  const entry = makeAccount({
    ...previous,
    key,
    username,
    password,
    label: String(input.label ?? previous.label ?? '').trim().slice(0, 40),
    enabled: input.enabled !== false,
    location: String(input.location ?? previous.location ?? '').trim(),
    autoAnswer: input.autoAnswer === undefined ? previous.autoAnswer !== false : input.autoAnswer === true,
  });
  const next = [...current];
  if (index >= 0) next[index] = entry;
  else next.push(entry);
  const file = writeAccountsEnv(dataDir, next);
  return { ok: true, key, file };
}

/** 从本地 accounts.env 删除指定账号。 */
export function deleteAccount(dataDir, key, options = {}) {
  const target = String(key || '').trim();
  if (!/^(main|a\d+)$/.test(target)) throw new Error('账号标识格式错误');
  const current = resolveAccounts(dataDir, options).accounts;
  const next = current.filter((a) => a.key !== target);
  if (next.length === current.length) throw new Error('未找到要删除的账号');
  const file = writeAccountsEnv(dataDir, next);
  return { ok: true, key: target, remaining: next.length, file };
}
