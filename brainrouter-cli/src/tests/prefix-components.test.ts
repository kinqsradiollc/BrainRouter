import test from 'node:test';
import assert from 'node:assert/strict';
import { computePrefixComponents, diffPrefixComponents } from '../runtime/contextRegions.js';

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
