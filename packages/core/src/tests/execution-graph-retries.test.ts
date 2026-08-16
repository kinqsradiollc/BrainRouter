/**
 * ADR-040 A40-7 — opt-in, bounded per-node retry, emitted as real attempts.
 *
 * A node that failed then recovered should SHOW the recovery — attempts 1, 2, 3 —
 * not present itself as a clean first-try success. Retry is opt-in (`retries: 0`
 * by default, so existing graphs are untouched), bounded, and draws from the same
 * execution budget so it can never bust the run's ceiling.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runGraph } from '../workflow/graph/graphEngine.js';
import { toExecutionEvent } from '../orchestration/execution/graphAdapter.js';
import { reduceExecutionEvents } from '../orchestration/execution/reducer.js';
import type { WorkflowGraph } from '../workflow/graph/graph.js';

function agentGraph(retries?: number): WorkflowGraph {
  return {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'a', type: 'agent', data: { prompt: 'go', ...(retries !== undefined ? { retries } : {}) } },
    ],
    edges: [{ id: 'e', source: 't', target: 'a' }],
  };
}

function snap(emissions: Parameters<typeof toExecutionEvent>[0][], executionId: string) {
  return reduceExecutionEvents(
    emissions.map((e, i) => ({ ...toExecutionEvent(e, 's', '2026-08-16T00:00:00.000Z'), executionSequence: i + 1, eventId: `${executionId}:${i + 1}` })),
  ).snapshot(executionId)!;
}

test('DEFAULT (no retries): a throwing node fails the run, exactly as before', async () => {
  const emissions: Parameters<typeof toExecutionEvent>[0][] = [];
  const result = await runGraph(agentGraph(), {
    runAgent: async () => { throw new Error('boom'); },
    emitExecution: (e) => emissions.push(e),
    executionId: 'exec-default',
  });
  assert.equal(result.ok, false);
  const s = snap(emissions, 'exec-default');
  // Exactly one attempt for the agent node — retry did not silently kick in.
  const attempts = s.occurrences.filter((o) => o.nodeId === 'a').map((o) => o.attempt);
  assert.deepEqual(attempts, [1]);
});

test('retry-then-succeed: a node that throws twice with retries:2 recovers, and every attempt shows', async () => {
  let calls = 0;
  const emissions: Parameters<typeof toExecutionEvent>[0][] = [];
  const result = await runGraph(agentGraph(2), {
    runAgent: async () => { calls += 1; if (calls <= 2) throw new Error('flaky'); return 'ok'; },
    emitExecution: (e) => emissions.push(e),
    executionId: 'exec-recover',
  });
  assert.equal(result.ok, true, 'the third attempt succeeded');
  assert.equal(calls, 3);
  const s = snap(emissions, 'exec-recover');
  const occ = s.occurrences.filter((o) => o.nodeId === 'a').sort((x, y) => x.attempt - y.attempt);
  assert.deepEqual(occ.map((o) => [o.attempt, o.status]), [[1, 'failed'], [2, 'failed'], [3, 'succeeded']]);
});

test('retry exhausted: a node that always throws with retries:1 emits attempts 1,2 then fails the run', async () => {
  let calls = 0;
  const emissions: Parameters<typeof toExecutionEvent>[0][] = [];
  const result = await runGraph(agentGraph(1), {
    runAgent: async () => { calls += 1; throw new Error('always'); },
    emitExecution: (e) => emissions.push(e),
    executionId: 'exec-exhaust',
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 2, 'one original + one retry');
  const s = snap(emissions, 'exec-exhaust');
  assert.deepEqual(s.occurrences.filter((o) => o.nodeId === 'a').map((o) => o.attempt).sort(), [1, 2]);
});

test('an OPTIONAL node that exhausts its retries degrades the run rather than failing it', async () => {
  const graph: WorkflowGraph = {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'a', type: 'agent', data: { prompt: 'go', retries: 1, optional: true } },
    ],
    edges: [{ id: 'e', source: 't', target: 'a' }],
  };
  const result = await runGraph(graph, { runAgent: async () => { throw new Error('x'); }, executionId: 'exec-opt' });
  assert.equal(result.ok, true, 'an optional node failing does not fail the run');
  assert.ok((result.degradedNodes ?? []).includes('a'));
});

test('retries draw from the shared execution budget — they cannot bust the run bound', async () => {
  let calls = 0;
  const result = await runGraph(agentGraph(5), {
    runAgent: async () => { calls += 1; throw new Error('flaky'); },
    executionBudget: 3,
    executionId: 'exec-budget',
  });
  assert.equal(result.ok, false);
  // 1 original + retries, but the budget (3) stops it well before all 5 retries.
  assert.ok(calls <= 3, `retries stopped at the budget, ran ${calls} times`);
});
