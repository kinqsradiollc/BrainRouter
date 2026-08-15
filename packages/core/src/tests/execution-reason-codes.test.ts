/**
 * ADR-040 A40-7 — typed compatibility failure mappings.
 *
 * A run that failed should say WHY in a bounded, typed code, not carry its raw
 * error string (unbounded, possibly sensitive) into a durable map. These pin the
 * mapping and its projection: a budget-exhausted run reads `budget-exhausted`,
 * an unrecognized failure reads the generic `error` (a known-unknown), and a real
 * failed graph run surfaces the code on its snapshot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalTerminalReasonCodes, runGraph } from '../workflow/graph/graphEngine.js';
import { toExecutionEvent } from '../orchestration/execution/graphAdapter.js';
import { reduceExecutionEvents } from '../orchestration/execution/reducer.js';
import type { WorkflowGraph } from '../workflow/graph/graph.js';

test('canonicalTerminalReasonCodes maps each known failure to one safe code', () => {
  assert.deepEqual(canonicalTerminalReasonCodes(undefined), []);
  assert.deepEqual(canonicalTerminalReasonCodes(''), []);
  assert.deepEqual(canonicalTerminalReasonCodes('execution budget exhausted (5 node executions)'), ['budget-exhausted']);
  assert.deepEqual(canonicalTerminalReasonCodes('run canceled'), ['canceled']);
  assert.deepEqual(canonicalTerminalReasonCodes('node fetch failed: boom'), ['node-failed']);
  assert.deepEqual(canonicalTerminalReasonCodes('graph is invalid: cycle'), ['invalid-definition']);
});

test('an unrecognized failure is the generic `error`, NEVER the raw string', () => {
  const raw = 'secret-token=abc123 leaked in an unexpected way';
  const codes = canonicalTerminalReasonCodes(raw);
  assert.deepEqual(codes, ['error']);
  assert.equal(codes.join('').includes('secret-token'), false, 'the raw error must not become a reason code');
});

test('a real failed graph run surfaces its typed terminal reason code on the snapshot', async () => {
  // A required node that throws fails the whole run with `node <id> failed: ...`.
  const graph: WorkflowGraph = {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'boom', type: 'agent', data: { prompt: 'go' } },
    ],
    edges: [{ id: 'e', source: 't', target: 'boom' }],
  };
  const emissions: Parameters<typeof toExecutionEvent>[0][] = [];
  const result = await runGraph(graph, {
    runAgent: async () => { throw new Error('kaboom'); },
    emitExecution: (e) => emissions.push(e),
    executionId: 'exec-fail',
  });
  assert.equal(result.ok, false);

  const snap = reduceExecutionEvents(
    emissions.map((e, i) => ({ ...toExecutionEvent(e, 'sess', '2026-08-16T00:00:00.000Z'), executionSequence: i + 1, eventId: `exec-fail:${i + 1}` })),
  ).snapshot('exec-fail')!;
  assert.equal(snap.status, 'failed');
  assert.deepEqual([...snap.terminalReasonCodes], ['node-failed'], 'the run says WHY it failed, in a typed code');
});

test('a run with no terminal reason codes projects an empty list, not undefined', () => {
  const snap = reduceExecutionEvents([
    { schemaVersion: 1, eventId: 'e:1', executionId: 'e', executionSequence: 1, sessionKey: 's', emittedAt: '2026-08-16T00:00:00.000Z', payload: { status: 'succeeded' } },
  ]).snapshot('e')!;
  assert.deepEqual(snap.terminalReasonCodes, []);
});
