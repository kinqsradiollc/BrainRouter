/**
 * ADR-027 D2 (P3-1/P3-2) — the graph executor.
 *
 * The tests that matter are about RESUME. A checkpoint taken at the wrong
 * moment, or a resume that re-enters at the wrong node, duplicates a side
 * effect — and a duplicated effect is invisible in the state that caused it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runGraph,
  graphDefinitionError,
  END,
  GraphDefinitionError,
  GraphExecutionError,
  type GraphDefinition,
} from '../graph/graphExecutor.js';
import { appendAll, lastValue, sum } from '../graph/graphState.js';

const schema = {
  log: { reducer: appendAll<string>() },
  status: { reducer: lastValue<string>() },
  count: { reducer: sum() },
};

function linear(trace: string[]): GraphDefinition<typeof schema> {
  return {
    schema,
    entry: 'a',
    nodes: [
      { id: 'a', run: () => { trace.push('a'); return { update: { log: ['a'], count: 1 } }; } },
      { id: 'b', run: () => { trace.push('b'); return { update: { log: ['b'], count: 1 } }; } },
    ],
    edges: { a: () => 'b', b: () => END },
  };
}

test('a linear graph runs to completion and folds state', async () => {
  const trace: string[] = [];
  const result = await runGraph(linear(trace));
  assert.equal(result.status, 'complete');
  assert.deepEqual(trace, ['a', 'b']);
  assert.deepEqual(result.state.get('log'), ['a', 'b']);
  assert.equal(result.state.get('count'), 2);
  assert.equal(result.checkpoint.next, END);
});

test('a node with no edge routes to END rather than falling through', async () => {
  // "Next in the array" would make routing depend on declaration order.
  const trace: string[] = [];
  const graph = { ...linear(trace), edges: { a: () => 'b' } };
  const result = await runGraph(graph);
  assert.equal(result.status, 'complete');
  assert.deepEqual(trace, ['a', 'b'], 'b still ran; it simply ended after');
});

test('conditional routing follows state, not declaration order', async () => {
  const graph: GraphDefinition<typeof schema> = {
    schema,
    entry: 'check',
    nodes: [
      { id: 'check', run: () => ({ update: { status: 'retry' } }) },
      { id: 'retry', run: () => ({ update: { log: ['retried'], status: 'done' } }) },
      { id: 'finish', run: () => ({ update: { log: ['finished'] } }) },
    ],
    edges: {
      check: (state) => (state.get('status') === 'retry' ? 'retry' : 'finish'),
      retry: () => 'finish',
      finish: () => END,
    },
  };
  const result = await runGraph(graph);
  assert.deepEqual(result.state.get('log'), ['retried', 'finished']);
});

test('a checkpoint is emitted after every node', async () => {
  const seen: string[] = [];
  await runGraph(linear([]), { onCheckpoint: (cp) => seen.push(cp.next) });
  assert.deepEqual(seen, ['b', END, END], 'after a, after b, and the terminal one');
});

test('an interrupt checkpoints the completed work and resumes AFTER that node', async () => {
  // Resuming at the interrupting node would re-run it — repeating the very
  // effect the interrupt was probably asking about.
  const trace: string[] = [];
  const graph: GraphDefinition<typeof schema> = {
    schema,
    entry: 'a',
    nodes: [
      { id: 'a', run: () => { trace.push('a'); return { update: { log: ['a'] } }; } },
      {
        id: 'pause',
        run: () => { trace.push('pause'); return { update: { log: ['pause'] }, interrupt: { reason: 'needs confirmation' } }; },
      },
      { id: 'c', run: () => { trace.push('c'); return { update: { log: ['c'] } }; } },
    ],
    edges: { a: () => 'pause', pause: () => 'c', c: () => END },
  };

  const paused = await runGraph(graph);
  assert.equal(paused.status, 'interrupted');
  assert.equal(paused.interrupt?.nodeId, 'pause');
  assert.equal(paused.interrupt?.reason, 'needs confirmation');
  assert.deepEqual(trace, ['a', 'pause']);
  assert.deepEqual(paused.state.get('log'), ['a', 'pause'], 'the interrupting node\'s work IS folded in');
  assert.equal(paused.checkpoint.next, 'c', 'resume goes to the successor, not back to pause');

  const resumed = await runGraph(graph, { from: paused.checkpoint });
  assert.equal(resumed.status, 'complete');
  assert.deepEqual(trace, ['a', 'pause', 'c'], 'pause did NOT run twice');
  assert.deepEqual(resumed.state.get('log'), ['a', 'pause', 'c']);
});

test('resume continues the step count rather than restarting it', async () => {
  // Otherwise a graph that interrupts repeatedly could never exhaust its
  // budget, and a routing cycle with an interrupt in it would spin forever.
  const trace: string[] = [];
  const paused = await runGraph({
    ...linear(trace),
    nodes: [
      { id: 'a', run: () => ({ update: { log: ['a'] }, interrupt: { reason: 'stop' } }) },
      { id: 'b', run: () => ({ update: { log: ['b'] } }) },
    ],
  });
  assert.equal(paused.stepsTaken, 1);
  const resumed = await runGraph(linear(trace), { from: paused.checkpoint });
  assert.equal(resumed.stepsTaken, 2);
});

test('a routing cycle terminates with an error rather than spinning', async () => {
  // Stopping silently mid-graph would look identical to completing.
  const graph: GraphDefinition<typeof schema> = {
    schema,
    entry: 'loop',
    nodes: [{ id: 'loop', run: () => ({ update: { count: 1 } }) }],
    edges: { loop: () => 'loop' },
    maxSteps: 5,
  };
  await assert.rejects(() => runGraph(graph), (error: Error) => {
    assert.ok(error instanceof GraphExecutionError);
    assert.match(error.message, /routing cycle/);
    return true;
  });
});

test('routing to an unknown node fails loudly', async () => {
  const graph: GraphDefinition<typeof schema> = {
    schema,
    entry: 'a',
    nodes: [{ id: 'a', run: () => ({}) }],
    edges: { a: () => 'ghost' },
  };
  await assert.rejects(() => runGraph(graph), /unknown node "ghost"/);
});

test('a side-effecting node without an idempotency key is rejected at definition time', () => {
  // A node that forgets its key is indistinguishable from a safe one until a
  // resume duplicates its effect in production.
  const graph: GraphDefinition<typeof schema> = {
    schema,
    entry: 'send',
    nodes: [{ id: 'send', sideEffecting: true, run: () => ({}) }],
  };
  assert.match(graphDefinitionError(graph)!, /must declare an idempotencyKey/);
  assert.rejects(() => runGraph(graph), GraphDefinitionError);
});

test('a side-effecting node WITH a key is accepted', () => {
  const graph: GraphDefinition<typeof schema> = {
    schema,
    entry: 'send',
    nodes: [{
      id: 'send',
      sideEffecting: true,
      idempotencyKey: (state) => `send:${state.get('count') ?? 0}`,
      run: () => ({}),
    }],
  };
  assert.equal(graphDefinitionError(graph), null);
});

test('definition errors are caught before anything runs', () => {
  const base = { schema, nodes: [{ id: 'a', run: () => ({}) }] };
  assert.match(graphDefinitionError({ ...base, entry: 'missing' })!, /Entry node "missing"/);
  assert.match(
    graphDefinitionError({ ...base, entry: 'a', nodes: [...base.nodes, { id: 'a', run: () => ({}) }] })!,
    /Duplicate node id/,
  );
  assert.match(
    graphDefinitionError({ ...base, entry: 'a', edges: { ghost: () => END } })!,
    /Edge declared from unknown node/,
  );
  assert.match(
    graphDefinitionError({ ...base, entry: 'a', nodes: [{ id: END, run: () => ({}) }] })!,
    /reserved/,
  );
});

test('an empty update advances the graph without changing state', async () => {
  const graph: GraphDefinition<typeof schema> = {
    schema,
    entry: 'noop',
    nodes: [{ id: 'noop', run: () => ({}) }],
  };
  const result = await runGraph(graph);
  assert.equal(result.status, 'complete');
  assert.equal(result.state.get('log'), undefined);
  assert.equal(result.stepsTaken, 1);
});
