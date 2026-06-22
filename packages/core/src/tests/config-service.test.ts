import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigService, ConfigService } from '../config/service.js';
import { getConfigPath, loadConfig, backfillApiKeyFromEnv } from '../config/config.js';

test('ConfigService is a stateless facade — delegates to the config lifecycle', () => {
  const svc = createConfigService();
  assert.ok(svc instanceof ConfigService);
  assert.equal(svc.getPath(), getConfigPath());
  assert.equal(svc.backfillApiKeyFromEnv(undefined), backfillApiKeyFromEnv(undefined));

  // load() depends on global on-disk config; prove identical behaviour whether it
  // returns or throws. save()/loadOrInit() write a global file, so we don't call them.
  const call = (fn: () => unknown): string => {
    try { return 'OK:' + JSON.stringify(fn()); } catch { return 'THREW'; }
  };
  assert.equal(call(() => svc.load()), call(() => loadConfig()));
});
