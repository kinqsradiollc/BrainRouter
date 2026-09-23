/**
 * ADR-052 P2a (D2) — per-automation token attribution. `recordDailyUsage` folds
 * each turn into an automation bucket, and `readAutomationUsage` /
 * `UsageService.automationBreakdown` surface per-automation totals costliest
 * first, so a runaway loop is identifiable by name instead of lost in one total.
 *
 * Own BRAINROUTER_HOME (module-level, mirrors usage-history.test.ts) so the
 * global usage-history.json is isolated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'br-autousage-'));
process.env.BRAINROUTER_HOME = TMP;

const { recordDailyUsage, readAutomationUsage } = await import('../usage/usageHistoryStore.js');
const { createUsageService } = await import('../usage/service.js');

const T0 = Date.UTC(2026, 7, 30, 12, 0, 0);
const DAY = 86_400_000;

test('recordDailyUsage folds a turn into its automation bucket; a turn with no attribution is total-only', () => {
  recordDailyUsage({ promptTokens: 100, completionTokens: 20, calls: 1 }, T0, 'goal');
  recordDailyUsage({ promptTokens: 40, completionTokens: 10, calls: 1 }, T0 + 3_600_000, 'goal'); // same day
  recordDailyUsage({ promptTokens: 5, completionTokens: 2, calls: 1 }, T0, 'interactive');
  recordDailyUsage({ promptTokens: 9, completionTokens: 1, calls: 1 }, T0); // no attribution

  const breakdown = readAutomationUsage(2, T0);
  const goal = breakdown.find((b) => b.automation === 'goal');
  const interactive = breakdown.find((b) => b.automation === 'interactive');
  assert.ok(goal && interactive);
  assert.deepEqual(
    { promptTokens: goal!.promptTokens, completionTokens: goal!.completionTokens, calls: goal!.calls, turns: goal!.turns },
    { promptTokens: 140, completionTokens: 30, calls: 2, turns: 2 },
  );
  assert.equal(interactive!.turns, 1);
  assert.ok(!breakdown.some((b) => b.automation === ''), 'an unattributed turn creates no bucket');
});

test('readAutomationUsage aggregates across days and sorts costliest first', () => {
  recordDailyUsage({ promptTokens: 1000, completionTokens: 500, calls: 1 }, T0 + DAY, 'fleet'); // next day, biggest
  const breakdown = readAutomationUsage(3, T0 + DAY);
  assert.equal(breakdown[0]!.automation, 'fleet', 'the costliest automation is first');
  // goal (140+30=170) still shows, below fleet (1500).
  assert.ok(breakdown.some((b) => b.automation === 'goal'));
});

test('UsageService.automationBreakdown surfaces the same per-automation totals', () => {
  const svc = createUsageService();
  svc.record({ promptTokens: 3, completionTokens: 1, calls: 1 }, T0 + 2 * DAY, 'interactive');
  const b = svc.automationBreakdown(4, T0 + 2 * DAY);
  assert.ok(b.some((x) => x.automation === 'interactive'));
  assert.ok(b.some((x) => x.automation === 'fleet'));
});
