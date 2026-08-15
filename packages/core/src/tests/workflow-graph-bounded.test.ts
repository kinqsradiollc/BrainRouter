/**
 * ADR-040 A40-3 — saved graph execution fails closed and stays bounded.
 *
 * Each test here pins a property whose absence is invisible in a passing run:
 * an approval that silently self-approves looks identical to an approved one,
 * and a graph that runs forever looks identical to a slow one until it is too
 * late.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowGraph } from '../workflow/graph/graph.js';
import {
  runGraph,
  DEFAULT_EXECUTION_BUDGET,
  type GraphRunDeps,
} from '../workflow/graph/graphEngine.js';

const echo: GraphRunDeps = { runAgent: async (prompt) => `AGENT(${prompt})` };

function approvalGraph(): WorkflowGraph {
  return {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'a', type: 'approval', data: { summary: 'Ship it?' } },
      { id: 'o', type: 'output', data: { template: 'shipped' } },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'a' },
      { id: 'e2', source: 'a', target: 'o', sourceHandle: 'approved' },
    ],
  };
}

test('an approval node with no approval port wired FAILS rather than self-approving', async () => {
  // The whole purpose of this node type is to stop and ask a person. Passing it
  // when nobody is wired up is the one behaviour it must never have.
  const result = await runGraph(approvalGraph(), echo);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /refusing to self-approve/i);
  // The run returns at the first error, so downstream nodes never even get a
  // record — which is the strongest form of "nothing past the gate ran".
  assert.equal(result.nodes.o, undefined, 'nothing downstream of the gate ran');
});

test('unattended approval is possible, but only when the caller says so explicitly', async () => {
  const result = await runGraph(approvalGraph(), { ...echo, allowUnattendedApproval: true });
  assert.equal(result.ok, true);
  assert.equal((result.nodes.a?.output as { unattended?: boolean })?.unattended, true,
    'the record says a human was not involved, so the map can show it');
  assert.equal(result.finalOutput, 'shipped');
});

test('a wired approval port still decides, in both directions', async () => {
  const approved = await runGraph(approvalGraph(), { ...echo, requestApproval: async () => true });
  assert.equal(approved.ok, true);
  assert.equal((approved.nodes.a?.output as { unattended?: boolean })?.unattended, false);

  const rejected = await runGraph(approvalGraph(), { ...echo, requestApproval: async () => false });
  assert.equal(rejected.nodes.a?.branch, 'rejected');
  assert.equal(rejected.nodes.o?.status, 'skipped', 'a rejection halts its branch');
});

test('the execution budget stops a run instead of letting it continue', async () => {
  const wide: WorkflowGraph = {
    nodes: [
      { id: 't', type: 'trigger' },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, type: 'agent' as const, data: { prompt: 'x' } })),
    ],
    edges: Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, source: 't', target: `n${i}` })),
  };
  const result = await runGraph(wide, { ...echo, executionBudget: 5 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /execution budget exhausted/i);
});

test('a generous budget does not interfere with an ordinary run', async () => {
  const small: WorkflowGraph = {
    nodes: [{ id: 't', type: 'trigger' }, { id: 'o', type: 'output', data: { template: 'done' } }],
    edges: [{ id: 'e1', source: 't', target: 'o' }],
  };
  const result = await runGraph(small, echo);
  assert.equal(result.ok, true, `default budget of ${DEFAULT_EXECUTION_BUDGET} must not trip a two-node graph`);
  assert.equal(result.finalOutput, 'done');
});

test('a subworkflow spends the SAME budget as its parent', async () => {
  // Sharing the counter by reference is the point: a per-run copy would let each
  // nesting level start over, so a "bounded" graph could still run unboundedly.
  const child: WorkflowGraph = {
    nodes: [
      { id: 'ct', type: 'trigger' },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, type: 'agent' as const, data: { prompt: 'y' } })),
    ],
    edges: Array.from({ length: 6 }, (_, i) => ({ id: `ce${i}`, source: 'ct', target: `c${i}` })),
  };
  const parent: WorkflowGraph = {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 's', type: 'subworkflow', data: { workflowId: 'child' } },
    ],
    edges: [{ id: 'e1', source: 't', target: 's' }],
  };
  // The numbers have to DISCRIMINATE, or the test passes either way and pins
  // nothing. Parent spends 2 of 8, leaving 6; the child needs 7. Shared budget
  // -> exhausted. A per-level budget of 8 would comfortably fit the child, so
  // this run succeeding is exactly the bug.
  const result = await runGraph(parent, {
    ...echo,
    executionBudget: 8,
    loadSubWorkflow: async () => child,
  });
  assert.equal(result.ok, false, 'the child cannot restart the parent budget');
  assert.match(result.error ?? '', /execution budget exhausted|failed/i);
});

test('an aborted signal stops the run at the next node', async () => {
  const controller = new AbortController();
  const chain: WorkflowGraph = {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'a', type: 'agent', data: { prompt: 'first' } },
      { id: 'b', type: 'agent', data: { prompt: 'second' } },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'a' },
      { id: 'e2', source: 'a', target: 'b' },
    ],
  };
  const result = await runGraph(chain, {
    runAgent: async (prompt) => { controller.abort(); return `AGENT(${prompt})`; },
    signal: controller.signal,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /canceled/i);
});

test('a REQUIRED node failing fails the run — fail-closed is the default', async () => {
  // A node is required unless its definition says otherwise, so forgetting to
  // mark one cannot silently turn a failure into a shrug.
  const graph: WorkflowGraph = {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'boom', type: 'agent', data: { prompt: 'x' } },
      { id: 'o', type: 'output', data: { template: 'done' } },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'boom' },
      { id: 'e2', source: 'boom', target: 'o' },
    ],
  };
  const result = await runGraph(graph, {
    runAgent: async () => { throw new Error('exploded'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /boom/);
});

test('an OPTIONAL node failing degrades the run instead of failing it', async () => {
  const graph: WorkflowGraph = {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'extra', type: 'agent', data: { prompt: 'x', optional: true } },
      { id: 'o', type: 'output', data: { template: 'done' } },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'extra' },
      { id: 'e2', source: 't', target: 'o' },
    ],
  };
  const result = await runGraph(graph, {
    runAgent: async () => { throw new Error('exploded'); },
  });
  assert.equal(result.ok, true, 'the rest of the run continues');
  assert.equal(result.finalOutput, 'done');
  assert.deepEqual([...(result.degradedNodes ?? [])], ['extra'],
    'the run reports WHAT did not happen rather than claiming it all worked');
});

test('a clean run reports no degradation, so degraded means something', async () => {
  const graph: WorkflowGraph = {
    nodes: [{ id: 't', type: 'trigger' }, { id: 'o', type: 'output', data: { template: 'done' } }],
    edges: [{ id: 'e1', source: 't', target: 'o' }],
  };
  const result = await runGraph(graph, echo);
  assert.deepEqual([...(result.degradedNodes ?? [])], []);
});
