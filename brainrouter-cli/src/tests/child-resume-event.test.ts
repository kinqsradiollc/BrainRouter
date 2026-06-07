import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldResumeOnChildComplete } from '../runtime/childResume.js';

const base = {
  exited: false,
  isProcessing: false,
  pendingContinuation: false,
  pendingIds: ['agent-1'],
  allSettled: true,
};

test('MAR-2 shouldResumeOnChildComplete: fires only when idle + armed + all settled', () => {
  assert.equal(shouldResumeOnChildComplete(base), true);
});

test('MAR-2 shouldResumeOnChildComplete: never fires while a turn is running', () => {
  assert.equal(shouldResumeOnChildComplete({ ...base, isProcessing: true }), false);
});

test('MAR-2 shouldResumeOnChildComplete: defers to the poll when children still in flight', () => {
  assert.equal(shouldResumeOnChildComplete({ ...base, allSettled: false }), false);
});

test('MAR-2 shouldResumeOnChildComplete: no-op when nothing is armed', () => {
  assert.equal(shouldResumeOnChildComplete({ ...base, pendingIds: [] }), false);
});

test('MAR-2 shouldResumeOnChildComplete: yields to a queued goal continuation and to exit', () => {
  assert.equal(shouldResumeOnChildComplete({ ...base, pendingContinuation: true }), false);
  assert.equal(shouldResumeOnChildComplete({ ...base, exited: true }), false);
});
