#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowDirectHosts } from './src/http.js';
import { ConfigStore } from './src/config.js';
import { RollcallWatcher } from './src/watcher.js';
import { ensureAccountsTemplate } from './src/accounts.js';

allowDirectHosts();

if (process.argv.includes('--check-once')) {
  const data = process.env.ROLLCALL_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), 'data');
  ensureAccountsTemplate(data);
  const watcher = new RollcallWatcher(new ConfigStore(data), data);
  const result = await watcher.checkOnce();
  console.log(JSON.stringify({
    ok: result.ok,
    activeCount: result.activeCount,
    reason: result.reason,
    accounts: watcher.getStatus().accounts.map(({ label, username, sessionActive, error }) => ({ label, username, sessionActive, error })),
  }, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} else {
  await import('./scripts/launch.cjs');
}
