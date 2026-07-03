import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunFanOutFollowThroughGuard } from '../agent/turn/fanOutFollowThroughGuard.js';

const base = {
  fanOutHinted: true,
  guardFired: 0,
  maxGuardFires: 1,
  spawnedChildCount: 0,
  interactiveTopLevel: true,
  internalSession: false,
};

test('fan-out follow-through guard runs for an interactive top-level missed fan-out', () => {
  assert.equal(shouldRunFanOutFollowThroughGuard(base), true);
});

test('fan-out follow-through guard is capped and skips when children were spawned', () => {
  assert.equal(shouldRunFanOutFollowThroughGuard({ ...base, guardFired: 1 }), false);
  assert.equal(shouldRunFanOutFollowThroughGuard({ ...base, spawnedChildCount: 1 }), false);
});

test('fan-out follow-through guard skips internal, child, and non-hinted turns', () => {
  assert.equal(shouldRunFanOutFollowThroughGuard({ ...base, internalSession: true }), false);
  assert.equal(shouldRunFanOutFollowThroughGuard({ ...base, interactiveTopLevel: false }), false);
  assert.equal(shouldRunFanOutFollowThroughGuard({ ...base, fanOutHinted: false }), false);
});
