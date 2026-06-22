import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageService, UsageService } from '../usage/service.js';
import { dayKey, readUsageHistory, totalUsage } from '../usage/usageHistoryStore.js';

test('UsageService is a stateless facade — delegates to the usage history store', () => {
  const svc = createUsageService();
  assert.ok(svc instanceof UsageService);

  // Pure + read-only delegation only — `record` writes a global file, so we do
  // not exercise it here (it would pollute real usage history).
  const now = 1_700_000_000_000;
  assert.equal(svc.dayKey(now), dayKey(now));
  assert.deepEqual(svc.total([]), totalUsage([]));
  assert.deepEqual(svc.readHistory(1, now), readUsageHistory(1, now));
});
