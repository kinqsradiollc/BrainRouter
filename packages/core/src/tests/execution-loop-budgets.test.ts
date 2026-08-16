/**
 * ADR-040 A40-5 — loop budgets: a bounded loop is SEEN to have stayed bounded.
 *
 * A loop that ran to its ceiling and one that stopped early look identical unless
 * both the allowed and the used counts are recorded. These pin the projection and
 * a real loop graph emitting its budget.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionEvent } from '@kinqs/brainrouter-agent-protocol';
import { reduceExecutionEvents } from '../orchestration/execution/reducer.js';
import { runGraph } from '../workflow/graph/graphEngine.js';
import { toExecutionEvent } from '../orchestration/execution/graphAdapter.js';
import type { WorkflowGraph } from '../workflow/graph/graph.js';

function ev(seq: number, payload: unknown): ExecutionEvent {
  return {
    schemaVersion: 1, eventId: `e:${seq}`, executionId: 'e', executionSequence: seq,
    sessionKey: 's', emittedAt: '2026-08-16T00:00:00.000Z', payload,
  };
}

test('a loop budget projects declared vs observed, and is NOT read as an occurrence', () => {
  const snap = reduceExecutionEvents([
    ev(1, { status: 'running' }),
    ev(2, { loopBudget: { nodeId: 'loop-1', declared: 10, observed: 3 } }),
  ]).snapshot('e')!;
  assert.equal(snap.loopBudgets.length, 1);
  assert.deepEqual(
    { ...snap.loopBudgets[0], sequence: undefined },
    { nodeId: 'loop-1', declared: 10, observed: 3, sequence: undefined },
  );
  // The loop-budget event must not have created a phantom occurrence.
  assert.equal(snap.occurrences.length, 0, 'loopBudget carries its own nodeId, so it is not an occurrence');
});

test('a run with no loops projects an empty loopBudgets list, not undefined', () => {
  const snap = reduceExecutionEvents([ev(1, { status: 'running' })]).snapshot('e')!;
  assert.deepEqual(snap.loopBudgets, []);
});

test('a real loop graph emits its budget: used stays at or under allowed', async () => {
  // A foreach loop over 3 items with maxIterations 10 uses 3 of its 10.
  const graph: WorkflowGraph = {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'seed', type: 'set', data: { fields: { items: [1, 2, 3] } } },
      { id: 'loop', type: 'loop', data: { mode: 'foreach', over: '{{$vars.items}}', maxIterations: 10 } },
    ],
    edges: [
      { id: 'e0', source: 't', target: 'seed' },
      { id: 'e1', source: 'seed', target: 'loop' },
    ],
  };
  const emissions: Parameters<typeof toExecutionEvent>[0][] = [];
  await runGraph(graph, { runAgent: async () => 'ok', emitExecution: (e) => emissions.push(e), executionId: 'exec-loop' });

  const snap = reduceExecutionEvents(
    emissions.map((e, i) => ({ ...toExecutionEvent(e, 'sess', '2026-08-16T00:00:00.000Z'), executionSequence: i + 1, eventId: `exec-loop:${i + 1}` })),
  ).snapshot('exec-loop')!;
  const budget = snap.loopBudgets.find((b) => b.nodeId === 'loop');
  assert.ok(budget, 'the loop node emitted a budget');
  assert.equal(budget!.declared, 10);
  assert.ok(budget!.observed <= budget!.declared, 'used never exceeds allowed');
  assert.ok(budget!.observed >= 1, 'the loop actually ran');
});
