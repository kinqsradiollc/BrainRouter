/**
 * ADR-040 A40-7 — the reducer projects edge traversals, and the graph engine
 * emits them.
 *
 * A map that shows only the edges that fired cannot say why a branch did not.
 * These pin both halves: the reducer records a traversal per edge event
 * (bounded, deduped), and a real graph run emits `traversed`/`skipped` for the
 * branch taken vs not taken.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionEvent } from '@kinqs/brainrouter-agent-protocol';
import {
  ExecutionSessionStore,
  reduceExecutionEvents,
  EXECUTION_STORE_BOUNDS,
} from '../orchestration/execution/reducer.js';
import { runGraph } from '../workflow/graph/graphEngine.js';
import { toExecutionEvent } from '../orchestration/execution/graphAdapter.js';
import type { WorkflowGraph } from '../workflow/graph/graph.js';

function ev(seq: number, payload: unknown): ExecutionEvent {
  return {
    schemaVersion: 1,
    eventId: `exec-1:${seq}`,
    executionId: 'exec-1',
    executionSequence: seq,
    sessionKey: 'sess-1',
    emittedAt: '2026-08-16T00:00:00.000Z',
    payload,
  };
}

test('the reducer projects an edge traversal, carrying its state and sequence', () => {
  const store = new ExecutionSessionStore();
  store.apply(ev(1, { status: 'running' }));
  store.apply(ev(2, { edgeId: 'e1', edgeState: 'traversed' }));
  store.apply(ev(3, { edgeId: 'e2', edgeState: 'skipped' }));
  const snap = store.snapshot('exec-1')!;
  assert.equal(snap.traversals.length, 2);
  assert.deepEqual(snap.traversals.map((t) => [t.edgeId, t.state, t.sequence]), [['e1', 'traversed', 2], ['e2', 'skipped', 3]]);
  assert.equal(snap.traversals[0].traversalId, 'exec-1:2');
});

test('an edge event with no state defaults to traversed, never dropped', () => {
  const snap = reduceExecutionEvents([ev(1, { status: 'running' }), ev(2, { edgeId: 'e1' })]).snapshot('exec-1')!;
  assert.equal(snap.traversals.length, 1);
  assert.equal(snap.traversals[0].state, 'traversed');
});

test('a replayed edge event is not double-counted', () => {
  const dup = ev(2, { edgeId: 'e1', edgeState: 'blocked' });
  const snap = reduceExecutionEvents([ev(1, { status: 'running' }), dup, dup]).snapshot('exec-1')!;
  assert.equal(snap.traversals.length, 1);
});

test('the traversal list is bounded, and exceeding the bound marks the snapshot truncated', () => {
  const events: ExecutionEvent[] = [ev(1, { status: 'running' })];
  const over = EXECUTION_STORE_BOUNDS.maxTraversalsPerExecution + 3;
  for (let i = 0; i < over; i += 1) events.push(ev(i + 2, { edgeId: `e${i}`, edgeState: 'traversed' }));
  const snap = reduceExecutionEvents(events).snapshot('exec-1')!;
  assert.equal(snap.traversals.length, EXECUTION_STORE_BOUNDS.maxTraversalsPerExecution);
  assert.equal(snap.truncated, true);
});

test('a run with no edges projects an empty traversals list, not undefined', () => {
  const snap = reduceExecutionEvents([ev(1, { status: 'running' })]).snapshot('exec-1')!;
  assert.deepEqual(snap.traversals, []);
});

test('a real branching graph emits traversed for the branch taken and skipped for the other', async () => {
  // condition -> true edge -> A, false edge -> B. With a true condition, the
  // true edge is traversed and the false edge is skipped.
  const graph: WorkflowGraph = {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'c', type: 'condition', data: { left: '1', op: '==', right: '1' } },
      { id: 'a', type: 'set', data: { fields: { x: 'A' } } },
      { id: 'b', type: 'set', data: { fields: { x: 'B' } } },
    ],
    edges: [
      { id: 'e0', source: 't', target: 'c' },
      { id: 'eTrue', source: 'c', target: 'a', sourceHandle: 'true' },
      { id: 'eFalse', source: 'c', target: 'b', sourceHandle: 'false' },
    ],
  };
  const emissions: Parameters<typeof toExecutionEvent>[0][] = [];
  const result = await runGraph(graph, {
    runAgent: async () => '',
    emitExecution: (e) => emissions.push(e),
    executionId: 'exec-branch',
  });
  assert.equal(result.ok, true);

  const store = reduceExecutionEvents(emissions.map((e, i) => ({ ...toExecutionEvent(e, 'sess', '2026-08-16T00:00:00.000Z'), executionSequence: i + 1, eventId: `exec-branch:${i + 1}` })));
  const snap = store.snapshot('exec-branch')!;
  const byEdge = new Map(snap.traversals.map((t) => [t.edgeId, t.state]));
  assert.equal(byEdge.get('eTrue'), 'traversed', 'the matched branch is traversed');
  assert.equal(byEdge.get('eFalse'), 'skipped', 'the branch not taken is skipped, not absent');
});
