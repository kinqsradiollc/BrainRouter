import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUsageBreakdown, type ActorUsage } from '../util/tokens/usageBreakdown.js';

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
  assert.match(text, /cache {7}40,000 tokens served from cache · 10,000 full-price \(80\.0% hit, 10,000 miss\)/);
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

// --- CC-UX-E3: per-category breakdown (skill / MCP server / cache miss) -----

test('CC-UX-E3 buildUsageBreakdown: by-skill section sorts descending and skips chat-only sessions', () => {
  // A session where a real skill ran → the section renders, sorted by total.
  const withSkills = buildUsageBreakdown({
    parent: { ...PARENT, cachedTokens: 0, missedTokens: 0 },
    children: [],
    bySkill: [
      { skill: 'chat', promptTokens: 1_000, completionTokens: 100, calls: 2, turns: 2 },
      { skill: 'code-review-and-quality', promptTokens: 8_000, completionTokens: 900, calls: 5, turns: 3 },
      { skill: 'spec-driven-skill', promptTokens: 4_000, completionTokens: 200, calls: 2, turns: 1 },
    ],
  }).join('\n');
  assert.match(withSkills, /By skill:/);
  // Highest-spend skill listed before the lower one, and before chat.
  const order = withSkills.indexOf('code-review-and-quality');
  assert.ok(order > 0 && order < withSkills.indexOf('spec-driven-skill'), 'skills sorted by total spend');
  assert.match(withSkills, /code-review-and-quality\s+8,000 in \/ 900 out · 5 calls · 3 turns/);

  // A plain chat session (only the `chat` bucket) → no redundant one-row table.
  const chatOnly = buildUsageBreakdown({
    parent: { ...PARENT, cachedTokens: 0, missedTokens: 0 },
    children: [],
    bySkill: [{ skill: 'chat', promptTokens: 500, completionTokens: 50, calls: 1, turns: 1 }],
  }).join('\n');
  assert.ok(!chatOnly.includes('By skill:'), 'chat-only session omits the by-skill table');
});

test('CC-UX-E3 buildUsageBreakdown: by-MCP-server section shows call counts, sorted, zero-filtered', () => {
  const text = buildUsageBreakdown({
    parent: { ...PARENT, cachedTokens: 0, missedTokens: 0 },
    children: [],
    byMcpServer: [
      { server: 'brainrouter', calls: 12 },
      { server: 'github', calls: 3 },
      { server: 'unused', calls: 0 },
    ],
  }).join('\n');
  assert.match(text, /By MCP server \(tool calls\):/);
  const first = text.indexOf('brainrouter');
  const second = text.indexOf('github');
  assert.ok(first > 0 && first < second, 'busiest server listed first');
  assert.match(text, /github\s+3 calls/);
  assert.match(text, /brainrouter\s+12 calls/);
  assert.ok(!text.includes('unused'), 'zero-call servers are filtered out');
});

test('CC-UX-E3 buildUsageBreakdown: cache line reports both hit % and miss token count', () => {
  const text = buildUsageBreakdown({ parent: PARENT, children: [] }).join('\n');
  assert.match(text, /80\.0% hit, 10,000 miss/);
});

test('CC-UX-E3 buildUsageBreakdown: no category sections when none provided (back-compat)', () => {
  const text = buildUsageBreakdown({ parent: { ...PARENT, cachedTokens: 0, missedTokens: 0 }, children: [] }).join('\n');
  assert.ok(!text.includes('By skill:'), 'no by-skill section without input');
  assert.ok(!text.includes('By MCP server'), 'no by-MCP section without input');
});

test('WS0 buildUsageBreakdown: no prefix line when nothing measured / fully stable has no last-bust', () => {
  const none = buildUsageBreakdown({ parent: PARENT, children: [], prefixStability: { stableCalls: 0, bustCalls: 0, ratio: 1, lastLabels: [] } }).join('\n');
  assert.ok(!none.includes('cache-stable'), 'no prefix line when zero calls measured');
  const stable = buildUsageBreakdown({ parent: PARENT, children: [], prefixStability: { stableCalls: 5, bustCalls: 0, ratio: 1, lastLabels: ['prefix stable — cache should hit'] } }).join('\n');
  assert.match(stable, /prefix {6}100\.0% cache-stable across 5 calls \(0 busts\)$/m);
});
