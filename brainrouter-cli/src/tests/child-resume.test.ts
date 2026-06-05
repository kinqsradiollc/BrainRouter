import test from 'node:test';
import assert from 'node:assert/strict';
import { unsettledChildIds, childrenSettled, buildChildResumePrompt } from '../runtime/childResume.js';

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
