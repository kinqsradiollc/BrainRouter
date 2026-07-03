import test from 'node:test';
import assert from 'node:assert/strict';
import { unsettledChildIds, childrenSettled, buildChildResumePrompt, unsynthesizedChildIds, mergePendingChildIds } from '../util/agentloop/childResume.js';

const STATUS: Record<string, string> = {
  a: 'running',
  b: 'completed',
  c: 'pending',
  d: 'failed',
  e: 'stale',
  // 'f' absent → vanished session
};
const statusOf = (id: string): string | undefined => STATUS[id];

test('C1 unsettledChildIds: only running/pending are in flight', () => {
  assert.deepEqual(unsettledChildIds(['a', 'b', 'c', 'd', 'e', 'f'], statusOf), ['a', 'c']);
  assert.deepEqual(unsettledChildIds([], statusOf), []);
  // A vanished/pruned session (undefined status) counts as settled — never blocks.
  assert.deepEqual(unsettledChildIds(['f'], statusOf), []);
});

test('C1 childrenSettled: true once nothing is in flight (empty is vacuously settled)', () => {
  assert.equal(childrenSettled(['b', 'd', 'e'], statusOf), true, 'completed/failed/stale → settled');
  assert.equal(childrenSettled(['a', 'b'], statusOf), false, 'one still running → not settled');
  assert.equal(childrenSettled([], statusOf), true);
  assert.equal(childrenSettled(['f'], statusOf), true, 'gone session → settled');
});

test('C1 buildChildResumePrompt: names the ids, calls wait_agents, forbids re-spawn', () => {
  const p = buildChildResumePrompt(['agent-1', 'agent-2']);
  assert.match(p, /agent-1, agent-2/);
  assert.match(p, /wait_agents/);
  assert.match(p, /\["agent-1","agent-2"\]/); // ids passed as a JSON array
  assert.match(p, /synthesize/i);
  assert.match(p, /Do not spawn new agents/i);
});

test('MAR-1 unsynthesizedChildIds: spawned − waited, deduped, order-preserving, skips junk', () => {
  const waited = new Set(['b']);
  // spawned a,b,c,a → drop b (waited) and the duplicate a → [a, c]
  assert.deepEqual(unsynthesizedChildIds(['a', 'b', 'c', 'a'], waited), ['a', 'c']);
  // all observed → nothing to resume
  assert.deepEqual(unsynthesizedChildIds(['b'], waited), []);
  // empty / junk ids are skipped
  assert.deepEqual(unsynthesizedChildIds(['', '(unknown)', 'x'], new Set<string>()), ['x']);
  // a Set is a valid Iterable input
  assert.deepEqual(unsynthesizedChildIds(new Set(['a', 'b']), waited), ['a']);
});

test('MAR-1 mergePendingChildIds: union, existing first, no dupes', () => {
  assert.deepEqual(mergePendingChildIds(['t1'], ['t2', 't1', 't3']), ['t1', 't2', 't3']);
  assert.deepEqual(mergePendingChildIds([], ['a', 'a']), ['a']);
  assert.deepEqual(mergePendingChildIds(['a'], []), ['a']);
});
