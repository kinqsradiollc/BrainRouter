import test from 'node:test';
import assert from 'node:assert/strict';
import { isLiveChild, countLiveChildren, countRunningChildren, spawnSlotDecision } from '../orchestration/spawnSlots.js';

test('CODEX-AGENT-LIFECYCLE isLiveChild: only pending/running count as live', () => {
  assert.equal(isLiveChild({ status: 'pending' }), true);
  assert.equal(isLiveChild({ status: 'running' }), true);
  for (const status of ['completed', 'failed', 'stale', 'closed'] as const) {
    assert.equal(isLiveChild({ status }), false, `${status} is terminal, not live`);
  }
});

test('CODEX-AGENT-LIFECYCLE countLiveChildren counts only live records', () => {
  const records = [
    { status: 'running' as const },
    { status: 'pending' as const },
    { status: 'completed' as const },
    { status: 'failed' as const },
    { status: 'running' as const },
  ];
  assert.equal(countLiveChildren(records), 3);
  assert.equal(countLiveChildren([]), 0);
});

test('CODEX-AGENT-LIFECYCLE countRunningChildren counts running only (orphan pending never wedges the cap)', () => {
  const records = [
    { status: 'running' as const },
    { status: 'pending' as const }, // orphan / pre-launch — must NOT count
    { status: 'running' as const },
    { status: 'completed' as const },
  ];
  assert.equal(countRunningChildren(records), 2);
  // A pile of orphan pendings does not occupy any run slot.
  assert.equal(countRunningChildren([{ status: 'pending' }, { status: 'pending' }]), 0);
});

test('CODEX-AGENT-LIFECYCLE spawnSlotDecision allows below the cap, denies at/over it', () => {
  assert.equal(spawnSlotDecision(0, 8).allow, true);
  assert.equal(spawnSlotDecision(7, 8).allow, true);
  const atCap = spawnSlotDecision(8, 8);
  assert.equal(atCap.allow, false);
  assert.match(atCap.reason, /spawn slot limit reached \(8\/8/);
  assert.match(atCap.reason, /wait_agent/);
  // Over cap (e.g. cap lowered at runtime) also denies.
  assert.equal(spawnSlotDecision(12, 8).allow, false);
});

test('CODEX-AGENT-LIFECYCLE a non-positive cap disables the limit', () => {
  assert.equal(spawnSlotDecision(100, 0).allow, true);
  assert.equal(spawnSlotDecision(100, -1).allow, true);
  assert.match(spawnSlotDecision(5, 0).reason, /no concurrency cap/);
});
