import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigService, ConfigService } from '../config/service.js';
import { getConfigPath, backfillApiKeyFromEnv } from '../config/config.js';

test('ConfigService is a stateless facade — delegates to the config lifecycle', () => {
  const svc = createConfigService();
  assert.ok(svc instanceof ConfigService);

  // Only the side-effect-free methods are exercised. load()/loadOrInit() are
  // FATAL when no config exists (they print + process.exit, which a try/catch
  // can't trap), and save() writes a global file — all three delegate by
  // construction (one-liners, type-checked).
  assert.equal(svc.getPath(), getConfigPath());
  assert.equal(typeof svc.getPath(), 'string');
  assert.equal(svc.backfillApiKeyFromEnv(undefined), backfillApiKeyFromEnv(undefined));
  assert.equal(svc.backfillApiKeyFromEnv('https://api.example.com'), backfillApiKeyFromEnv('https://api.example.com'));
});
