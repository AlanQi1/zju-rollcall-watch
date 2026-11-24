// 开源发布前去隐私与产物审计：检查仓库与构建产物中是否包含敏感文件或隐私信息。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const forbiddenFiles = [];
const sensitiveHits = [];
const SKIP_DIRS = new Set(['node_modules', '.git', 'release']);
const BINARY_RE = /\.(exe|ico|png|jpg|jpeg|webp|zip|asar|dll|bin|pak|dat)$/i;
const FORBIDDEN_FILE_RE = /(^|[\\/])(accounts\.(env|json)|credentials\.env|\.env|config\.json|auto-sign\.json|reminded\.json|report\.json|startup-error\.txt)$/i;
const SENSITIVE_PATTERNS = [
  { name: 'hardcoded_windows_user_path', re: /[A-Z]:\\Users\\[^\s"'`]+/g },
  { name: 'private_dsh_reference', re: /DSH_HOME|\.dsh[\\/]|zju-campus/g },
  { name: 'real_zju_student_id_32x', re: /\b32[0-9]{7,8}\b/g },
];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    if (entry.isDirectory()) {
      if (/^(data|backup-)/i.test(entry.name)) {
        forbiddenFiles.push(rel);
      } else {
        walk(full);
      }
      continue;
    }
    if (FORBIDDEN_FILE_RE.test(rel) && !rel.endsWith('.env.example')) {
      forbiddenFiles.push(rel);
    }
    if (BINARY_RE.test(entry.name)) continue;
    if (rel === join('scripts', 'audit-release.mjs')) continue;
    const content = readFileSync(full, 'utf8');
    for (const { name, re } of SENSITIVE_PATTERNS) {
      re.lastIndex = 0;
      const matches = content.match(re);
      if (matches?.length) {
        sensitiveHits.push({ file: rel, rule: name, count: matches.length });
      }
    }
  }
}

walk(root);

const exePath = join(root, 'release', `RollcallRadar-${pkg.version}-Windows-x64.exe`);
const exeExists = existsSync(exePath);
const result = {
  version: pkg.version,
  exeExists,
  exePath: exeExists ? relative(root, exePath) : null,
  exeBytes: exeExists ? statSync(exePath).size : 0,
  forbiddenFiles,
  sensitiveHits,
  passed: forbiddenFiles.length === 0 && sensitiveHits.length === 0,
};

console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
