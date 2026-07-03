import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateGraph,
  topoOrder,
  detectCycle,
  interpolate,
  stripSecretsForExport,
  type WorkflowGraph,
} from '../workflow/graph/graph.js';
import { runGraph, runSingleNode, type GraphRunDeps } from '../workflow/graph/graphEngine.js';

const echoAgent: GraphRunDeps = { runAgent: async (prompt) => `AGENT(${prompt})` };

function graph(nodes: WorkflowGraph['nodes'], edges: WorkflowGraph['edges'], vars?: Record<string, unknown>): WorkflowGraph {
  return { nodes, edges, vars };
}

test('validateGraph: accepts a well-formed graph, flags the broken ones', () => {
  const good = graph(
    [{ id: 't', type: 'trigger' }, { id: 'o', type: 'output' }],
    [{ id: 'e1', source: 't', target: 'o' }],
  );
  assert.deepEqual(validateGraph(good), { ok: true, errors: [] });

  const dupId = graph([{ id: 'x', type: 'trigger' }, { id: 'x', type: 'output' }], []);
  assert.match(validateGraph(dupId).errors.join(), /duplicate node id: x/);

  const dangling = graph([{ id: 't', type: 'trigger' }], [{ id: 'e', source: 't', target: 'ghost' }]);
  assert.match(validateGraph(dangling).errors.join(), /target "ghost" is not a node/);

  const noTrigger = graph([{ id: 'o', type: 'output' }], []);
  assert.match(validateGraph(noTrigger).errors.join(), /no trigger node/);
});

test('detectCycle / topoOrder', () => {
  const acyclic = graph(
    [{ id: 't', type: 'trigger' }, { id: 'a', type: 'agent' }, { id: 'o', type: 'output' }],
    [{ id: 'e1', source: 't', target: 'a' }, { id: 'e2', source: 'a', target: 'o' }],
  );
  assert.equal(detectCycle(acyclic), false);
  const order = topoOrder(acyclic);
  assert.ok(order.indexOf('t') < order.indexOf('a'));
  assert.ok(order.indexOf('a') < order.indexOf('o'));

  const cyclic = graph(
    [{ id: 't', type: 'trigger' }, { id: 'a', type: 'agent' }],
    [{ id: 'e1', source: 't', target: 'a' }, { id: 'e2', source: 'a', target: 't' }],
  );
  assert.equal(detectCycle(cyclic), true);
  assert.throws(() => topoOrder(cyclic), /cycle/);
});

test('interpolate: $vars, $nodes path, missing → empty, object → JSON', () => {
  const ctx = { vars: { topic: 'cats' }, nodes: { a1: { text: 'hello' }, n: { obj: { k: 1 } } } };
  assert.equal(interpolate('Write about {{$vars.topic}}', ctx), 'Write about cats');
  assert.equal(interpolate('got {{$nodes.a1.text}}', ctx), 'got hello');
  assert.equal(interpolate('missing [{{$vars.nope}}]', ctx), 'missing []');
  assert.equal(interpolate('{{$nodes.n.obj}}', ctx), '{"k":1}');
});

test('stripSecretsForExport: scrubs credential-like fields, keeps the rest, no mutation', () => {
  const g = graph(
    [{ id: 't', type: 'trigger' }, { id: 'a', type: 'agent', data: { prompt: 'hi', apiKey: 'SECRET', nested: { token: 'T', keep: 'ok' } } }],
    [],
  );
  const exported = stripSecretsForExport(g);
  const a = exported.nodes.find((n) => n.id === 'a')!;
  assert.equal(a.data!.apiKey, '');
  assert.equal((a.data!.nested as Record<string, unknown>).token, '');
  assert.equal((a.data!.nested as Record<string, unknown>).keep, 'ok');
  assert.equal(a.data!.prompt, 'hi');
  // original untouched
  assert.equal(g.nodes.find((n) => n.id === 'a')!.data!.apiKey, 'SECRET');
});

test('runGraph: linear trigger → agent → output with interpolation', async () => {
  const g = graph(
    [
      { id: 't', type: 'trigger' },
      { id: 'a1', type: 'agent', data: { prompt: 'Write about {{$vars.topic}}' } },
      { id: 'o', type: 'output', data: { template: 'Result: {{$nodes.a1.text}}' } },
    ],
    [
      { id: 'e1', source: 't', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'o' },
    ],
    { topic: 'cats' },
  );
  const r = await runGraph(g, echoAgent);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.finalOutput, 'Result: AGENT(Write about cats)');
  assert.equal(r.nodes.a1.status, 'ok');
});

test('runGraph: condition routes down only the matching branch', async () => {
  const g = graph(
    [
      { id: 't', type: 'trigger' },
      { id: 'c', type: 'condition', data: { left: '{{$vars.x}}', op: '==', right: '1' } },
      { id: 'yes', type: 'agent', data: { prompt: 'yes path' } },
      { id: 'no', type: 'agent', data: { prompt: 'no path' } },
    ],
    [
      { id: 'e1', source: 't', target: 'c' },
      { id: 'e2', source: 'c', target: 'yes', sourceHandle: 'true' },
      { id: 'e3', source: 'c', target: 'no', sourceHandle: 'false' },
    ],
    { x: '1' },
  );
  const r = await runGraph(g, echoAgent);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.nodes.c.branch, 'true');
  assert.equal(r.nodes.yes.status, 'ok');
  assert.equal(r.nodes.no.status, 'skipped');
});

test('runGraph: set writes run vars used by a later node; merge collects upstream', async () => {
  const g = graph(
    [
      { id: 't', type: 'trigger' },
      { id: 's', type: 'set', data: { fields: { greeting: 'hi {{$vars.name}}' } } },
      { id: 'a', type: 'agent', data: { prompt: 'say {{$vars.greeting}}' } },
      { id: 'm', type: 'merge' },
    ],
    [
      { id: 'e1', source: 't', target: 's' },
      { id: 'e2', source: 's', target: 'a' },
      { id: 'e3', source: 's', target: 'm' },
      { id: 'e4', source: 'a', target: 'm' },
    ],
    { name: 'Ada' },
  );
  const r = await runGraph(g, echoAgent);
  assert.equal(r.ok, true, r.error);
  assert.equal((r.nodes.a.output as { text: string }).text, 'AGENT(say hi Ada)');
  assert.equal((r.nodes.m.output as { inputs: unknown[] }).inputs.length, 2);
});

test('runGraph: an agent-node error fails the run (fail-closed) with a clear message', async () => {
  const g = graph(
    [{ id: 't', type: 'trigger' }, { id: 'a', type: 'agent', data: { prompt: 'boom' } }],
    [{ id: 'e1', source: 't', target: 'a' }],
  );
  const failing: GraphRunDeps = { runAgent: async () => { throw new Error('model exploded'); } };
  const r = await runGraph(g, failing);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /node a failed: model exploded/);
  assert.equal(r.nodes.a.status, 'error');
});

test('runSingleNode: condition test affordance evaluates in isolation', async () => {
  const rec = await runSingleNode(
    { id: 'c', type: 'condition', data: { left: 'foo', op: 'contains', right: 'o' } },
    { nodes: {}, vars: {} },
    echoAgent,
  );
  assert.equal(rec.branch, 'true');
  assert.deepEqual(rec.output, { result: true });
});

// ===========================================================================
// §7 L3 — advanced nodes
// ===========================================================================

const ctx0 = () => ({ nodes: {}, vars: {} });

test('switch: branches to the matching case, else default', async () => {
  const hit = await runSingleNode({ id: 's', type: 'switch', data: { value: '{{$vars.tier}}', cases: ['free', 'pro'] } }, { nodes: {}, vars: { tier: 'pro' } }, echoAgent);
  assert.equal(hit.branch, 'pro');
  const miss = await runSingleNode({ id: 's', type: 'switch', data: { value: '{{$vars.tier}}', cases: ['free', 'pro'] } }, { nodes: {}, vars: { tier: 'enterprise' } }, echoAgent);
  assert.equal(miss.branch, 'default');
});

test('runGraph: switch routes only down the matching handle (default falls through)', async () => {
  const g = graph(
    [
      { id: 't', type: 'trigger' },
      { id: 'sw', type: 'switch', data: { value: '{{$vars.k}}', cases: ['a', 'b'] } },
      { id: 'na', type: 'agent', data: { prompt: 'A' } },
      { id: 'nb', type: 'agent', data: { prompt: 'B' } },
      { id: 'nd', type: 'agent', data: { prompt: 'D' } },
    ],
    [
      { id: 'e0', source: 't', target: 'sw' },
      { id: 'e1', source: 'sw', target: 'na', sourceHandle: 'a' },
      { id: 'e2', source: 'sw', target: 'nb', sourceHandle: 'b' },
      { id: 'e3', source: 'sw', target: 'nd', sourceHandle: 'default' },
    ],
    { k: 'b' },
  );
  const r = await runGraph(g, echoAgent);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.nodes.nb.status, 'ok');
  assert.equal(r.nodes.na.status, 'skipped');
  assert.equal(r.nodes.nd.status, 'skipped');
});

test('filter: keeps items matching field/op/value', async () => {
  const rec = await runSingleNode(
    { id: 'f', type: 'filter', data: { source: '[{"score":"9"},{"score":"3"},{"score":"7"}]', field: 'score', op: '>', value: '5' } },
    ctx0(), echoAgent,
  );
  assert.deepEqual((rec.output as { items: unknown[] }).items, [{ score: '9' }, { score: '7' }]);
});

test('sort: orders an array by a field (numeric desc) and string asc', async () => {
  const numeric = await runSingleNode(
    { id: 's', type: 'sort', data: { source: '[{"n":"2"},{"n":"10"},{"n":"1"}]', field: 'n', order: 'desc', numeric: true } },
    ctx0(), echoAgent,
  );
  assert.deepEqual((numeric.output as { items: Array<{ n: string }> }).items.map((x) => x.n), ['10', '2', '1']);
  const str = await runSingleNode(
    { id: 's', type: 'sort', data: { source: '["banana","apple","cherry"]' } },
    ctx0(), echoAgent,
  );
  assert.deepEqual((str.output as { items: string[] }).items, ['apple', 'banana', 'cherry']);
});

test('limit: takes the first N', async () => {
  const rec = await runSingleNode({ id: 'l', type: 'limit', data: { source: '[1,2,3,4,5]', count: 2 } }, ctx0(), echoAgent);
  assert.deepEqual((rec.output as { items: unknown[] }).items, [1, 2]);
});

test('aggregate: count / sum / avg / join over a field', async () => {
  const src = '[{"v":"10"},{"v":"20"},{"v":"30"}]';
  const count = await runSingleNode({ id: 'a', type: 'aggregate', data: { source: src, op: 'count' } }, ctx0(), echoAgent);
  assert.equal((count.output as { value: number }).value, 3);
  const sum = await runSingleNode({ id: 'a', type: 'aggregate', data: { source: src, op: 'sum', field: 'v' } }, ctx0(), echoAgent);
  assert.equal((sum.output as { value: number }).value, 60);
  const avg = await runSingleNode({ id: 'a', type: 'aggregate', data: { source: src, op: 'avg', field: 'v' } }, ctx0(), echoAgent);
  assert.equal((avg.output as { value: number }).value, 20);
  const join = await runSingleNode({ id: 'a', type: 'aggregate', data: { source: src, op: 'join', field: 'v', separator: '-' } }, ctx0(), echoAgent);
  assert.equal((join.output as { value: string }).value, '10-20-30');
});

test('loop foreach: runs the body once per item with {{$vars.item}}', async () => {
  const rec = await runSingleNode(
    { id: 'lp', type: 'loop', data: { mode: 'foreach', source: '["x","y","z"]', prompt: 'do {{$vars.item}}#{{$vars.index}}' } },
    ctx0(), echoAgent,
  );
  const out = rec.output as { outputs: string[]; iterations: number };
  assert.equal(out.iterations, 3);
  assert.deepEqual(out.outputs, ['AGENT(do x#0)', 'AGENT(do y#1)', 'AGENT(do z#2)']);
});

test('loop refine: stops early when the output contains the stop string', async () => {
  let calls = 0;
  const deps: GraphRunDeps = { runAgent: async () => { calls++; return calls >= 2 ? 'looks DONE now' : 'keep going'; } };
  const rec = await runSingleNode(
    { id: 'lp', type: 'loop', data: { mode: 'refine', maxIterations: 5, stopContains: 'DONE', prompt: 'improve {{$vars.last}}' } },
    ctx0(), deps,
  );
  const out = rec.output as { text: string; iterations: number };
  assert.equal(out.iterations, 2);
  assert.equal(out.text, 'looks DONE now');
});

test('approval: auto-passes with no approver; injected reject halts the branch', async () => {
  const auto = await runSingleNode({ id: 'ap', type: 'approval', data: {} }, ctx0(), echoAgent);
  assert.equal(auto.branch, 'approved');
  assert.equal((auto.output as { auto: boolean }).auto, true);

  const g = graph(
    [
      { id: 't', type: 'trigger' },
      { id: 'ap', type: 'approval', data: { summary: 'ship it?' } },
      { id: 'after', type: 'agent', data: { prompt: 'shipped' } },
    ],
    [
      { id: 'e0', source: 't', target: 'ap' },
      { id: 'e1', source: 'ap', target: 'after' },
    ],
  );
  const rejecting: GraphRunDeps = { runAgent: async (p) => `AGENT(${p})`, requestApproval: async () => false };
  const r = await runGraph(g, rejecting);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.nodes.ap.branch, 'rejected');
  assert.equal(r.nodes.after.status, 'skipped'); // unconditional edge still halted
});

test('extract: parses an LLM JSON reply into output.fields', async () => {
  const deps: GraphRunDeps = { runAgent: async () => 'Sure! {"city":"Paris","days":3} hope that helps' };
  const rec = await runSingleNode({ id: 'ex', type: 'extract', data: { prompt: 'pull trip params', fields: ['city', 'days'] } }, ctx0(), deps);
  assert.deepEqual((rec.output as { fields: unknown }).fields, { city: 'Paris', days: 3 });
});

test('classify: branch is the matched label', async () => {
  const deps: GraphRunDeps = { runAgent: async () => 'this is clearly a billing question' };
  const rec = await runSingleNode({ id: 'cl', type: 'classify', data: { input: '...', labels: ['billing', 'technical', 'sales'] } }, ctx0(), deps);
  assert.equal(rec.branch, 'billing');
  assert.equal((rec.output as { label: string }).label, 'billing');
});

test('subworkflow: runs a loaded graph and surfaces its finalOutput', async () => {
  const child: WorkflowGraph = {
    id: 'child',
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'o', type: 'output', data: { template: 'child saw {{$vars.passed}}' } },
    ],
    edges: [{ id: 'e', source: 't', target: 'o' }],
  };
  const parent = graph(
    [
      { id: 't', type: 'trigger' },
      { id: 'sw', type: 'subworkflow', data: { workflowId: 'child', inputs: { passed: 'hello' } } },
      { id: 'o', type: 'output', data: { template: 'parent got [{{$nodes.sw.text}}]' } },
    ],
    [
      { id: 'e0', source: 't', target: 'sw' },
      { id: 'e1', source: 'sw', target: 'o' },
    ],
  );
  const deps: GraphRunDeps = { runAgent: async (p) => `AGENT(${p})`, loadSubWorkflow: async (id) => (id === 'child' ? child : null) };
  const r = await runGraph(parent, deps);
  assert.equal(r.ok, true, r.error);
  assert.equal((r.nodes.sw.output as { text: string }).text, 'child saw hello');
  assert.equal(r.finalOutput, 'parent got [child saw hello]');
});

test('subworkflow: recursion is detected and fails closed', async () => {
  const selfRef: WorkflowGraph = {
    id: 'loop-self',
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'sw', type: 'subworkflow', data: { workflowId: 'loop-self' } },
    ],
    edges: [{ id: 'e', source: 't', target: 'sw' }],
  };
  const deps: GraphRunDeps = { runAgent: async (p) => p, loadSubWorkflow: async () => selfRef };
  const r = await runGraph(selfRef, deps);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /recursion detected/);
});

test('subworkflow: missing loader / missing graph fail with a clear message', async () => {
  const g = graph(
    [{ id: 't', type: 'trigger' }, { id: 'sw', type: 'subworkflow', data: { workflowId: 'nope' } }],
    [{ id: 'e', source: 't', target: 'sw' }],
  );
  const noLoader = await runGraph(g, echoAgent);
  assert.equal(noLoader.ok, false);
  assert.match(noLoader.error ?? '', /no loader wired/);

  const notFound = await runGraph(g, { runAgent: async (p) => p, loadSubWorkflow: async () => null });
  assert.equal(notFound.ok, false);
  assert.match(notFound.error ?? '', /not found: nope/);
});
