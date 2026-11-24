import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const DEFAULTS = Object.freeze({ intervalMs: 30000, notify: true, notifySound: true, notifySeconds: 0, renotifyMs: 600000, autoRelogin: true, logLimit: 300, autoAnswer: false, autoDefaultLocation: '', autoFallback: false });
export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
export function normalizeConfig(raw = {}) {
  const merged = { ...DEFAULTS, ...raw };
  return {
    intervalMs: clampNumber(merged.intervalMs, 15000, 600000, DEFAULTS.intervalMs),
    notify: merged.notify !== false, notifySound: merged.notifySound !== false,
    notifySeconds: clampNumber(merged.notifySeconds, 0, 3600, 0),
    renotifyMs: clampNumber(merged.renotifyMs, 0, 86400000, DEFAULTS.renotifyMs),
    autoRelogin: merged.autoRelogin !== false,
    autoAnswer: merged.autoAnswer === true,
    autoDefaultLocation: String(merged.autoDefaultLocation || '').trim().slice(0, 120),
    autoFallback: merged.autoFallback === true,
    logLimit: Math.round(clampNumber(merged.logLimit, 20, 1000, 300)),
  };
}
export class ConfigStore {
  constructor(dataDir) { this.dataDir = dataDir; this.file = join(dataDir, 'config.json'); }
  load() {
    let raw = {};
    try { raw = JSON.parse(readFileSync(this.file, 'utf8')); } catch { /* 用默认值继续运行 */ }
    return normalizeConfig(raw);
  }
  patch(patch) {
    const next = normalizeConfig({ ...this.load(), ...patch });
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(`${this.file}.tmp`, this.file);
    return next;
  }
  ensureFile() {
    if (!existsSync(this.file)) this.patch({});
    return { path: this.file };
  }
}
