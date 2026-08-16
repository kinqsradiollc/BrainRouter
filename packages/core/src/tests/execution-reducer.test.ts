/**
 * ADR-040 A40-5 — the Core reducer.
 *
 * Each of these pins a property that fails SILENTLY. A reducer that
 * double-counts a replay, renders a gapped stream as if it were whole, or lets a
 * late event revive a finished run still produces a snapshot that looks fine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionEvent } from '@kinqs/brainrouter-agent-protocol';
import {
  ExecutionSessionStore,
  reduceExecutionEvents,
  EXECUTION_STORE_BOUNDS,
} from '../orchestration/execution/reducer.js';

function event(
  sequence: number,
  payload: unknown,
  over: Partial<ExecutionEvent> = {},
): ExecutionEvent {
  return {
    schemaVersion: 1,
    eventId: `ev-${sequence}`,
    executionId: 'exec-1',
    executionSequence: sequence,
    sessionKey: 'session-1',
    emittedAt: '2026-08-15T00:00:00.000Z',
    payload,
    ...over,
  };
}

const usage = { promptTokens: 10, completionTokens: 5, toolCalls: 1, wallClockMs: 100 };

test('a contiguous stream reduces to a complete snapshot', () => {
  const store = reduceExecutionEvents([
    event(1, { status: 'running' }),
    event(2, { nodeId: 'n1', attempt: 1, status: 'succeeded', usage }),
    event(3, { status: 'succeeded' }),
  ]);
  const snap = store.snapshot('exec-1')!;
  assert.equal(snap.status, 'succeeded');
  assert.equal(snap.completeness, 'complete');
  assert.equal(snap.watermark, 3);
  assert.equal(snap.occurrences.length, 1);
  assert.equal(snap.usage.promptTokens, 10);
});

test('a replayed event changes nothing — reconnection must not double-count', () => {
  const store = new ExecutionSessionStore();
  assert.equal(store.apply(event(1, { status: 'running' })), true);
  assert.equal(store.apply(event(2, { nodeId: 'n1', attempt: 1, usage })), true);
  // The same event arriving again, as it does on every reconnect.
  assert.equal(store.apply(event(2, { nodeId: 'n1', attempt: 1, usage })), false);
  const snap = store.snapshot('exec-1')!;
  assert.equal(snap.usage.promptTokens, 10, 'usage must not double');
  assert.equal(snap.occurrences.length, 1);
});

test('an out-of-order event replayed BEFORE its gap fills is still applied once', () => {
  // The watermark alone cannot catch this one: sequence 3 is above the
  // watermark both times it arrives, so only per-event identity stops it being
  // folded twice. Without that, a reconnect during a gap doubles the usage of
  // every buffered event — and the totals are then wrong in a way nothing in
  // the snapshot reveals.
  const store = new ExecutionSessionStore();
  store.apply(event(1, { status: 'running' }));
  assert.equal(store.apply(event(3, { nodeId: 'n3', attempt: 1, usage })), true, 'buffered');
  assert.equal(store.apply(event(3, { nodeId: 'n3', attempt: 1, usage })), false, 'replay ignored');

  store.apply(event(2, { nodeId: 'n2', attempt: 1, usage }));
  const snap = store.snapshot('exec-1')!;
  assert.equal(snap.completeness, 'complete');
  assert.equal(snap.usage.promptTokens, 20, 'two distinct events, counted once each');
  assert.equal(snap.occurrences.length, 2);
});

test('a hole makes the snapshot GAPPED rather than quietly partial', () => {
  // Rendering the events you happen to hold as if they were all of them is the
  // failure this exists to prevent.
  const store = new ExecutionSessionStore();
  store.apply(event(1, { status: 'running' }));
  store.apply(event(3, { status: 'succeeded' }));
  const snap = store.snapshot('exec-1')!;
  assert.equal(snap.completeness, 'gapped');
  assert.equal(snap.watermark, 1, 'the watermark stops at the last contiguous event');
  assert.equal(snap.status, 'running', 'the held-back event is NOT applied');
  assert.deepEqual([...snap.pendingSequences], [3]);
});

test('filling the hole applies the buffered events and restores completeness', () => {
  const store = new ExecutionSessionStore();
  store.apply(event(1, { status: 'running' }));
  store.apply(event(3, { status: 'succeeded' }));
  assert.equal(store.snapshot('exec-1')!.completeness, 'gapped');

  store.apply(event(2, { nodeId: 'n1', attempt: 1, usage }));
  const snap = store.snapshot('exec-1')!;
  assert.equal(snap.completeness, 'complete');
  assert.equal(snap.watermark, 3);
  assert.equal(snap.status, 'succeeded', 'the buffered event was drained in order');
});

test('a late event cannot resurrect a finished run', () => {
  const store = new ExecutionSessionStore();
  store.apply(event(1, { status: 'running' }));
  store.apply(event(2, { status: 'failed' }));
  store.apply(event(3, { status: 'running' }));
  assert.equal(store.snapshot('exec-1')!.status, 'failed');
});

test('a late event cannot rewrite one terminal state into another', () => {
  const store = new ExecutionSessionStore();
  store.apply(event(1, { status: 'cancelled' }));
  store.apply(event(2, { status: 'succeeded' }));
  assert.equal(store.snapshot('exec-1')!.status, 'cancelled',
    'a cancelled run must not report success because a late event said so');
});

test('a retry is a separate occurrence, so the failure it replaced survives', () => {
  const store = reduceExecutionEvents([
    event(1, { nodeId: 'n1', attempt: 1, status: 'failed' }),
    event(2, { nodeId: 'n1', attempt: 2, status: 'succeeded' }),
  ]);
  const snap = store.snapshot('exec-1')!;
  assert.equal(snap.occurrences.length, 2, 'the retry did not overwrite the failure');
  assert.deepEqual(snap.occurrences.map((o) => o.status).sort(), ['failed', 'succeeded']);
});

test('nested iterations stay distinct instead of collapsing onto each other', () => {
  const store = reduceExecutionEvents([
    event(1, { nodeId: 'n1', attempt: 1, iterationPath: [0, 1], status: 'succeeded' }),
    event(2, { nodeId: 'n1', attempt: 1, iterationPath: [1, 0], status: 'failed' }),
  ]);
  assert.equal(store.snapshot('exec-1')!.occurrences.length, 2);
});

test('an execution the store has never seen is unavailable, not complete', () => {
  // "I have nothing" and "there was nothing" are different answers.
  const store = new ExecutionSessionStore();
  assert.equal(store.completenessFor('never-heard-of-it'), 'unavailable');
  assert.equal(store.snapshot('never-heard-of-it'), undefined);
});

test('the store stays bounded and says so when it drops events', () => {
  const store = new ExecutionSessionStore();
  const over = EXECUTION_STORE_BOUNDS.maxEventsPerExecution + 10;
  for (let i = 1; i <= over; i += 1) {
    store.apply(event(i, { nodeId: `n${i}`, attempt: 1 }));
  }
  const snap = store.snapshot('exec-1')!;
  assert.equal(snap.truncated, true);
  assert.equal(snap.completeness, 'gapped',
    'a truncated snapshot must not present itself as the whole story');
});

test('the store evicts old executions rather than growing without limit', () => {
  const store = new ExecutionSessionStore();
  const over = EXECUTION_STORE_BOUNDS.maxExecutions + 25;
  for (let i = 0; i < over; i += 1) {
    store.apply(event(1, { status: 'running' }, {
      executionId: `exec-${i}`,
      eventId: `ev-${i}-1`,
    }));
  }
  assert.ok(store.size <= EXECUTION_STORE_BOUNDS.maxExecutions);
  assert.equal(store.completenessFor('exec-0'), 'unavailable', 'the oldest went first');
  assert.notEqual(store.completenessFor(`exec-${over - 1}`), 'unavailable', 'the newest is kept');
});

test('two executions do not share state', () => {
  const store = new ExecutionSessionStore();
  store.apply(event(1, { status: 'failed' }, { executionId: 'a', eventId: 'a1' }));
  store.apply(event(1, { status: 'succeeded' }, { executionId: 'b', eventId: 'b1' }));
  assert.equal(store.snapshot('a')!.status, 'failed');
  assert.equal(store.snapshot('b')!.status, 'succeeded');
});
