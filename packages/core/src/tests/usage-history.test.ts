import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the persistent usage store under a throwaway home (same pattern as the
// extension-store tests).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'br-usage-'));
process.env.BRAINROUTER_HOME = TMP;

const { recordDailyUsage, readUsageHistory, totalUsage, dayKey } = await import('../usage/usageHistoryStore.js');

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 5, 22, 12, 0, 0); // 2026-06-22 12:00 UTC (month is 0-based)

test('WS10 dayKey: UTC day bucket', () => {
  assert.equal(dayKey(T0), '2026-06-22');
});

test('WS10 recordDailyUsage accumulates per day and survives re-read', () => {
  recordDailyUsage({ promptTokens: 100, completionTokens: 20, calls: 1 }, T0);
  recordDailyUsage({ promptTokens: 50, completionTokens: 10, calls: 2 }, T0 + 3_600_000); // same day
  recordDailyUsage({ promptTokens: 7, completionTokens: 3, calls: 1 }, T0 + DAY); // next day
  const byDay = Object.fromEntries(readUsageHistory(2, T0 + DAY).map((d) => [d.day, d]));
  assert.equal(byDay['2026-06-22'].promptTokens, 150);
  assert.equal(byDay['2026-06-22'].completionTokens, 30);
  assert.equal(byDay['2026-06-22'].calls, 3);
  assert.equal(byDay['2026-06-22'].turns, 2, 'two turns recorded on day 1');
  assert.equal(byDay['2026-06-23'].turns, 1);
});

test('WS10 readUsageHistory fills gaps with zero days (continuous heatmap grid)', () => {
  const hist = readUsageHistory(5, T0 + DAY);
  assert.equal(hist.length, 5);
  const empty = hist.find((d) => d.day === dayKey(T0 - DAY));
  assert.ok(empty && empty.turns === 0 && empty.promptTokens === 0, 'a no-data day is zero-filled');
});

test('WS10 totalUsage sums records over the range', () => {
  const t = totalUsage(readUsageHistory(2, T0 + DAY));
  assert.equal(t.promptTokens, 157);
  assert.equal(t.turns, 3);
});

test('WS10 the tally is a durable file under the home (survives session delete)', () => {
  assert.ok(fs.existsSync(path.join(TMP, 'usage-history.json')), 'usage-history.json written under BRAINROUTER_HOME');
});
