/**
 * ADR-040 A40-7 — the reducer PROJECTS decisions, it does not drop them.
 *
 * Decisions (an approval granted, a node degraded) are emitted into the event
 * stream; before this they were reduced to nothing, so a run's decisions were
 * unqueryable and a test could claim "the decision reached the map" while
 * asserting only the node. These pin the projection: a decision that rides on
 * the same event as an occurrence records BOTH, a replay does not double-count,
 * and the list is bounded.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionEvent } from '@kinqs/brainrouter-agent-protocol';
import { ExecutionSessionStore, reduceExecutionEvents, EXECUTION_STORE_BOUNDS } from '../orchestration/execution/reducer.js';

function ev(seq: number, payload: unknown): ExecutionEvent {
  return {
    schemaVersion: 1,
    eventId: `exec-1:${seq}`,
    executionId: 'exec-1',
    executionSequence: seq,
    sessionKey: 'sess-1',
    emittedAt: '2026-08-16T00:00:00.000Z',
    nodeExecutionId: (payload as { nodeId?: string }).nodeId,
    payload,
  };
}

test('a decision riding on an occurrence event records BOTH the node and the decision', () => {
  const store = new ExecutionSessionStore();
  store.apply(ev(1, { status: 'running' }));
  // One event advances node `ap` AND records the approval made at it.
  store.apply(ev(2, {
    nodeId: 'ap', attempt: 1, status: 'succeeded',
    decision: { kind: 'approval', outcome: 'approved', reasonCodes: ['unattended'] },
  }));
  const snap = store.snapshot('exec-1')!;
  assert.ok(snap.occurrences.some((o) => o.nodeId === 'ap'), 'the occurrence is still recorded');
  assert.equal(snap.decisions.length, 1);
  const d = snap.decisions[0];
  assert.equal(d.kind, 'approval');
  assert.equal(d.outcome, 'approved');
  assert.equal(d.nodeExecutionId, 'ap');
  assert.deepEqual([...d.reasonCodes], ['unattended']);
  assert.equal(d.decisionId, 'exec-1:2');
});

test('an unfamiliar decision kind is surfaced as emitted, not dropped or coerced', () => {
  const snap = reduceExecutionEvents([
    ev(1, { status: 'running' }),
    ev(2, { decision: { kind: 'brand-new-kind', outcome: 'x', reasonCodes: [] } }),
  ]).snapshot('exec-1')!;
  assert.equal(snap.decisions.length, 1);
  assert.equal(snap.decisions[0].kind, 'brand-new-kind');
});

test('a replayed decision event is not double-counted', () => {
  const dup = ev(2, { decision: { kind: 'degradation', outcome: 'optional_node_failed', reasonCodes: ['optional', 'n'] } });
  const snap = reduceExecutionEvents([ev(1, { status: 'running' }), dup, dup]).snapshot('exec-1')!;
  assert.equal(snap.decisions.length, 1, 'the duplicate is dropped by eventId before folding');
});

test('the decisions list is bounded, and exceeding the bound marks the snapshot truncated', () => {
  const events: ExecutionEvent[] = [ev(1, { status: 'running' })];
  const over = EXECUTION_STORE_BOUNDS.maxDecisionsPerExecution + 5;
  for (let i = 0; i < over; i += 1) {
    events.push(ev(i + 2, { decision: { kind: 'guard', outcome: `o${i}`, reasonCodes: [] } }));
  }
  const snap = reduceExecutionEvents(events).snapshot('exec-1')!;
  assert.equal(snap.decisions.length, EXECUTION_STORE_BOUNDS.maxDecisionsPerExecution);
  assert.equal(snap.truncated, true);
});

test('a run with no decisions projects an empty decisions list, not undefined', () => {
  const snap = reduceExecutionEvents([ev(1, { status: 'running' }), ev(2, { nodeId: 'n', attempt: 1, status: 'succeeded' })]).snapshot('exec-1')!;
  assert.deepEqual(snap.decisions, []);
});
