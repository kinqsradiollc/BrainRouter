import test from 'node:test';
import assert from 'node:assert/strict';
import { computePrefixComponents, diffPrefixComponents, newPrefixStabilityTally, accumulatePrefixStability, prefixStabilityRatio } from '../context/contextRegions.js';

const sys = { role: 'system' as const, content: 'You are BrainRouter.' };
const anchor = { role: 'user' as const, content: 'ANCHOR: prefer vitest', meta: { pinned: true } };
const toolsA = [{ name: 'read_file', inputSchema: {} }, { name: 'grep', inputSchema: {} }];

test('CLI-5 computePrefixComponents: per-region hashes + tool names + anchor count', () => {
  const c = computePrefixComponents([sys, anchor, { role: 'user', content: 'hello (not pinned)' }], toolsA);
  assert.equal(c.toolNames.length, 2);
  assert.deepEqual(c.toolNames.sort(), ['grep', 'read_file']);
  assert.equal(c.anchorCount, 1);
  assert.ok(c.systemHash && c.toolsHash && c.anchorsHash);
});

test('CLI-5 diffPrefixComponents: first turn → pinned; stable → cache hit', () => {
  const c = computePrefixComponents([sys], toolsA);
  assert.equal(diffPrefixComponents(null, c).changed, false);
  assert.match(diffPrefixComponents(null, c).labels[0], /first turn/);
  const same = computePrefixComponents([sys], toolsA);
  const d = diffPrefixComponents(c, same);
  assert.equal(d.changed, false);
  assert.match(d.labels[0], /stable/);
});

test('CLI-5 diffPrefixComponents: labels which region drifted (the cache-miss cause)', () => {
  const before = computePrefixComponents([sys, anchor], toolsA);
  // tool removed + anchor changed + system changed
  const after = computePrefixComponents(
    [{ role: 'system', content: 'You are BrainRouter v2.' }],
    [{ name: 'read_file', inputSchema: {} }],
  );
  const d = diffPrefixComponents(before, after);
  assert.equal(d.changed, true);
  assert.ok(d.labels.some((l) => /system prompt changed/.test(l)));
  assert.ok(d.labels.some((l) => /tool-list changed \(-1\)/.test(l)));
  assert.ok(d.labels.some((l) => /memory anchors changed \(1→0\)/.test(l)));
});

// --- WS0 prefix-cache stability tally -------------------------------------

test('WS0 accumulatePrefixStability: first call is stable (pinning, not a bust)', () => {
  const tally = newPrefixStabilityTally();
  const c = computePrefixComponents([sys], toolsA);
  const drift = accumulatePrefixStability(tally, null, c);
  assert.equal(drift.changed, false);
  assert.equal(tally.stableCalls, 1);
  assert.equal(tally.bustCalls, 0);
  assert.equal(prefixStabilityRatio(tally), 1);
});

test('WS0 accumulatePrefixStability: unchanged prefix counts as a stable (cache) hit', () => {
  const tally = newPrefixStabilityTally();
  let prev = computePrefixComponents([sys], toolsA);
  accumulatePrefixStability(tally, null, prev); // first
  for (let i = 0; i < 3; i++) {
    const curr = computePrefixComponents([sys, { role: 'user', content: `step ${i} (not pinned)` }], toolsA);
    accumulatePrefixStability(tally, prev, curr); // append-region growth must NOT count as a bust
    prev = curr;
  }
  assert.equal(tally.bustCalls, 0, 'growing the (unpinned) conversation does not bust the prefix');
  assert.equal(tally.stableCalls, 4);
  assert.equal(prefixStabilityRatio(tally), 1);
});

test('WS0 accumulatePrefixStability: a changed prefix is a bust, with the cause in lastLabels', () => {
  const tally = newPrefixStabilityTally();
  const a = computePrefixComponents([sys], toolsA);
  accumulatePrefixStability(tally, null, a); // first → stable
  const b = computePrefixComponents([sys], [{ name: 'read_file', inputSchema: {} }]); // tool dropped
  const drift = accumulatePrefixStability(tally, a, b);
  assert.equal(drift.changed, true);
  assert.equal(tally.bustCalls, 1);
  assert.equal(tally.stableCalls, 1);
  assert.equal(prefixStabilityRatio(tally), 0.5);
  assert.ok(tally.lastLabels.some((l) => /tool-list changed/.test(l)));
});

test('WS0 prefixStabilityRatio: empty tally is treated as perfectly stable', () => {
  assert.equal(prefixStabilityRatio(newPrefixStabilityTally()), 1);
});
