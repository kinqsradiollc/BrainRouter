import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateGraph,
  topoOrder,
  detectCycle,
  interpolate,
  stripSecretsForExport,
  type WorkflowGraph,
} from '../workflow/graph.js';
import { runGraph, runSingleNode, type GraphRunDeps } from '../workflow/graphEngine.js';

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
