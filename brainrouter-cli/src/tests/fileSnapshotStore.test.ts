import test from 'node:test';
import assert from 'node:assert/strict';
import { planRestore, type FileMutationRecord } from '../state/fileSnapshotStore.js';

const rec = (turn: number, path: string, priorContent: string | null): FileMutationRecord => ({ turn, path, priorContent });

// Consistent history:
//   turn 1: edit a.ts  A0 -> A1            record(1, a, "A0")
//   turn 2: create b.ts -> B1              record(2, b, null)
//           edit a.ts  A1 -> A2            record(2, a, "A1")
//   turn 3: edit a.ts  A2 -> A3            record(3, a, "A2")
const HISTORY: FileMutationRecord[] = [rec(1, 'a.ts', 'A0'), rec(2, 'b.ts', null), rec(2, 'a.ts', 'A1'), rec(3, 'a.ts', 'A2')];

test('0.4.x-3b planRestore: rewind to turn 1 reverts a.ts to end-of-turn-1 + deletes b.ts', () => {
  const actions = planRestore(HISTORY, 1);
  // sorted by path: a.ts (write A1 = end of turn 1), b.ts (delete = didn't exist at end of turn 1)
  assert.deepEqual(actions, [
    { path: 'a.ts', action: 'write', content: 'A1' },
    { path: 'b.ts', action: 'delete' },
  ]);
});

test('0.4.x-3b planRestore: rewind to turn 2 reverts only a.ts; b.ts untouched (created in turn 2)', () => {
  const actions = planRestore(HISTORY, 2);
  assert.deepEqual(actions, [{ path: 'a.ts', action: 'write', content: 'A2' }]);
});

test('0.4.x-3b planRestore: rewind to the latest turn restores nothing', () => {
  assert.deepEqual(planRestore(HISTORY, 3), []);
  assert.deepEqual(planRestore([], 5), []);
});

test('0.4.x-3b planRestore: earliest post-N prior content wins per file', () => {
  // two mutations of a.ts after turn 0: keep the EARLIEST prior (turn 1, "A0").
  const actions = planRestore([rec(3, 'a.ts', 'late'), rec(1, 'a.ts', 'A0')], 0);
  assert.deepEqual(actions, [{ path: 'a.ts', action: 'write', content: 'A0' }]);
});
