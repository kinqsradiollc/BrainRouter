import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUsageBreakdown, type ActorUsage } from '../util/usageBreakdown.js';

const PARENT = { promptTokens: 50_000, completionTokens: 4_000, calls: 20, turns: 5, cachedTokens: 40_000, missedTokens: 10_000 };

test('buildUsageBreakdown: parent line with cache hit-rate + totals + child share', () => {
  const children: ActorUsage[] = [
    { id: 'agent-1', role: 'explorer', promptTokens: 9_000, completionTokens: 1_000, calls: 6, wallClockMs: 12_300 },
    { id: 'agent-2', role: 'reviewer', label: 'sec', promptTokens: 3_000, completionTokens: 500, calls: 2 },
  ];
  const text = buildUsageBreakdown({ parent: PARENT, children, offload: { childTokensSpent: 13_500, offloadCharsAvoided: 42_000 } }).join('\n');
  assert.match(text, /parent {6}50,000 in \/ 4,000 out · 20 calls · 5 turns · cache hit 80\.0%/);
  assert.match(text, /explorer agent-1 — 9,000 in \/ 1,000 out · 6 calls · 12\.3s/);
  assert.match(text, /reviewer "sec" agent-2 — 3,000 in \/ 500 out · 2 calls/);
  assert.match(text, /TOTAL {7}62,000 in \/ 5,500 out/);
  assert.match(text, /offload {5}42,000 chars/);
});

test('WS0 0.5 buildUsageBreakdown: cache-savings line shows cached/full-price token counts', () => {
  const text = buildUsageBreakdown({ parent: PARENT, children: [] }).join('\n');
  assert.match(text, /cache {7}40,000 tokens served from cache · 10,000 full-price \(80\.0% hit\)/);
});

test('WS0 0.5 buildUsageBreakdown: no cache line when the provider reported no cache stats', () => {
  const text = buildUsageBreakdown({ parent: { ...PARENT, cachedTokens: 0, missedTokens: 0 }, children: [] }).join('\n');
  assert.ok(!text.includes('served from cache'), 'no cache-savings line when nothing is cacheable');
});

test('buildUsageBreakdown: children sorted by total spend; >10 rolled up', () => {
  const children: ActorUsage[] = Array.from({ length: 12 }, (_, i) => ({
    id: `a${i}`, role: 'worker', promptTokens: (i + 1) * 100, completionTokens: 0, calls: 1,
  }));
  const lines = buildUsageBreakdown({ parent: { ...PARENT, cachedTokens: 0, missedTokens: 0 }, children });
  const firstChild = lines.find((l) => l.includes('worker a'));
  assert.match(firstChild!, /a11/, 'largest spender listed first');
  assert.match(lines.join('\n'), /…and 2 more children — 300 in \/ 0 out/);
  assert.ok(!lines.join('\n').includes('cache hit'), 'no cache line when nothing measured');
});

test('buildUsageBreakdown: no children → parent + TOTAL only', () => {
  const text = buildUsageBreakdown({ parent: PARENT, children: [] }).join('\n');
  assert.match(text, /TOTAL {7}50,000 in \/ 4,000 out \(children: 0\.0%\)/);
});

test('WS0 buildUsageBreakdown: prefix-stability line shows ratio, bust count + last cause', () => {
  const text = buildUsageBreakdown({
    parent: PARENT,
    children: [],
    prefixStability: { stableCalls: 9, bustCalls: 1, ratio: 0.9, lastLabels: ['tool-list changed (+1)'] },
  }).join('\n');
  assert.match(text, /prefix {6}90\.0% cache-stable across 10 calls \(1 bust\) · last bust: tool-list changed \(\+1\)/);
});

test('WS0 buildUsageBreakdown: no prefix line when nothing measured / fully stable has no last-bust', () => {
  const none = buildUsageBreakdown({ parent: PARENT, children: [], prefixStability: { stableCalls: 0, bustCalls: 0, ratio: 1, lastLabels: [] } }).join('\n');
  assert.ok(!none.includes('cache-stable'), 'no prefix line when zero calls measured');
  const stable = buildUsageBreakdown({ parent: PARENT, children: [], prefixStability: { stableCalls: 5, bustCalls: 0, ratio: 1, lastLabels: ['prefix stable — cache should hit'] } }).join('\n');
  assert.match(stable, /prefix {6}100\.0% cache-stable across 5 calls \(0 busts\)$/m);
});
