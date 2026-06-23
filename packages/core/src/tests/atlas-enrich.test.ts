import test from 'node:test';
import assert from 'node:assert/strict';
import type { AtlasGraph } from '@kinqs/brainrouter-types';
import { extractAtlasJson, extractAtlasJsonArray } from '../atlas/jsonExtract.js';
import { enrichAtlasGraph, type AtlasLlmCaller } from '../atlas/enrich.js';

// ---------- jsonExtract ----------

test('ATLAS-4 extractAtlasJson: plain, fenced, prose-wrapped, trailing commas', () => {
  assert.deepEqual(extractAtlasJson('[1,2,3]'), [1, 2, 3]);
  assert.deepEqual(extractAtlasJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractAtlasJson('Here is the JSON:\n{"a":1}\nThanks!'), { a: 1 });
  assert.deepEqual(extractAtlasJson('[1, 2, 3, ]'), [1, 2, 3]); // trailing comma
  assert.equal(extractAtlasJson('no json here'), null);
  assert.equal(extractAtlasJson(''), null);
});

test('ATLAS-4 extractAtlasJson: braces inside strings do not break balancing', () => {
  assert.deepEqual(extractAtlasJson('prefix {"k":"a } b ] c"} suffix'), { k: 'a } b ] c' });
});

test('ATLAS-4 extractAtlasJsonArray: unwraps {files:[...]} and degrades to []', () => {
  assert.deepEqual(extractAtlasJsonArray('{"files":[{"x":1}]}'), [{ x: 1 }]);
  assert.deepEqual(extractAtlasJsonArray('garbage'), []);
  assert.deepEqual(extractAtlasJsonArray('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
});

// ---------- enrichAtlasGraph ----------

function baseGraph(): AtlasGraph {
  return {
    schemaVersion: 1,
    kind: 'codebase',
    project: { name: 'demo', languages: ['typescript'], analyzedAt: '2026-06-22T00:00:00Z', totalFiles: 3 },
    nodes: [
      { id: 'file:src/app.ts', type: 'file', name: 'app.ts', filePath: 'src/app.ts', language: 'typescript', category: 'code' },
      { id: 'file:src/db.ts', type: 'file', name: 'db.ts', filePath: 'src/db.ts', language: 'typescript', category: 'code' },
      { id: 'config:package.json', type: 'config', name: 'package.json', filePath: 'package.json', language: 'json', category: 'config' },
      { id: 'function:src/app.ts:main', type: 'function', name: 'main', filePath: 'src/app.ts', lineRange: [1, 5] },
      { id: 'class:src/db.ts:Store', type: 'class', name: 'Store', filePath: 'src/db.ts', lineRange: [1, 9] },
    ],
    edges: [
      { source: 'file:src/app.ts', target: 'function:src/app.ts:main', type: 'contains' },
      { source: 'file:src/db.ts', target: 'class:src/db.ts:Store', type: 'contains' },
      // cross-layer import (Entry → Data) so the relationship pass has a pair
      { source: 'file:src/app.ts', target: 'file:src/db.ts', type: 'imports' },
    ],
    layers: [],
    tour: [],
  };
}

// A stub LLM that branches on the prompt and exercises the JSON extractor
// (fenced output for summaries, prose-wrapped for layers, bare for tour).
const goodLlm: AtlasLlmCaller = async ({ user }) => {
  // NB: branch order matters — check the most specific marker first. The
  // relationships prompt also contains the words "architectural layers", so it
  // must be matched before the layers branch.
  if (user.includes('relationship verb phrase')) {
    return JSON.stringify([
      { source: 'Entry', target: 'Data', label: 'reads from' },
      // a bogus pair the graph doesn't have — must be dropped
      { source: 'Data', target: 'Config', label: 'ignores' },
    ]);
  }
  if (user.includes('one object per file')) {
    return '```json\n' + JSON.stringify([
      { path: 'src/app.ts', summary: 'Application entry point.', tags: ['entry', 'async'], complexity: 'moderate' },
      { path: 'src/db.ts', summary: 'Data persistence layer.', tags: ['data'], complexity: 'complex' },
      { path: 'package.json', summary: 'Package manifest.', tags: ['config'], complexity: 'simple' },
    ]) + '\n```';
  }
  if (user.includes('architectural layers')) {
    return 'Sure, here you go:\n' + JSON.stringify([
      { name: 'Entry', description: 'App entry.', files: ['src/app.ts'] },
      { name: 'Data', description: 'Persistence.', files: ['src/db.ts', 'does/not/exist.ts'] },
      { name: 'Config', description: 'Build config.', files: ['package.json'] },
    ]);
  }
  if (user.includes('onboarding tour')) {
    return JSON.stringify([
      { title: 'Start at the entry', description: 'Read app.ts.', files: ['src/app.ts'] },
      { title: 'Understand storage', description: 'Read db.ts.', files: ['src/db.ts'] },
    ]);
  }
  return '[]';
};

test('ATLAS-4 enrichAtlasGraph merges summaries/tags/complexity, layers, tour', async () => {
  const input = baseGraph();
  const res = await enrichAtlasGraph(input, goodLlm);

  assert.equal(res.summarized, 3);
  assert.equal(res.batchesFailed, 0);

  const app = res.graph.nodes.find((n) => n.id === 'file:src/app.ts')!;
  assert.equal(app.summary, 'Application entry point.');
  assert.deepEqual(app.tags, ['entry', 'async']);
  assert.equal(app.complexity, 'moderate');

  // input graph is NOT mutated
  assert.equal(input.nodes.find((n) => n.id === 'file:src/app.ts')!.summary, undefined);

  // layers: 3 produced; the bogus path is dropped, config path resolves to the
  // config node id (not file:package.json).
  assert.equal(res.layers, 3);
  const data = res.graph.layers.find((l) => l.name === 'Data')!;
  assert.deepEqual(data.nodeIds, ['file:src/db.ts']);
  const config = res.graph.layers.find((l) => l.name === 'Config')!;
  assert.deepEqual(config.nodeIds, ['config:package.json']);

  // tour: ordered, node ids resolved
  assert.equal(res.tourSteps, 2);
  assert.equal(res.graph.tour[0].order, 1);
  assert.equal(res.graph.tour[1].order, 2);
  assert.deepEqual(res.graph.tour[0].nodeIds, ['file:src/app.ts']);
});

test('ATLAS enrichAtlasGraph: relationship pass labels real cross-layer edges, drops bogus ones', async () => {
  const res = await enrichAtlasGraph(baseGraph(), goodLlm);
  assert.equal(res.relationships, 1);
  assert.deepEqual(res.graph.layerEdges, [{ source: 'layer:entry', target: 'layer:data', label: 'reads from' }]);
  // the Data→Config label is dropped (no such import edge in the graph)
  assert.ok(!(res.graph.layerEdges ?? []).some((e) => e.label === 'ignores'));
});

test('ATLAS-4 enrichAtlasGraph respects maxFiles', async () => {
  let summaryCalls = 0;
  const counting: AtlasLlmCaller = async ({ user }) => {
    if (user.includes('one object per file')) { summaryCalls++; return '[]'; }
    return '[]';
  };
  const res = await enrichAtlasGraph(baseGraph(), counting, { maxFiles: 1, batchSize: 10 });
  // only 1 file-level node summarised → exactly one batch
  assert.equal(summaryCalls, 1);
  assert.equal(res.summarized, 0); // stub returned no rows
});

test('ATLAS-4 enrichAtlasGraph degrades gracefully on unparseable output', async () => {
  const badLlm: AtlasLlmCaller = async () => 'I cannot help with that.';
  const res = await enrichAtlasGraph(baseGraph(), badLlm, { batchSize: 10 });
  assert.equal(res.summarized, 0);
  assert.ok(res.batchesFailed >= 1);
  assert.equal(res.layers, 0); // no summaries → no layers
  assert.equal(res.tourSteps, 0);
  // graph still valid shape
  assert.equal(res.graph.nodes.length, baseGraph().nodes.length);
});

test('ATLAS-4 enrichAtlasGraph never throws when the LLM rejects', async () => {
  const throwing: AtlasLlmCaller = async () => { throw new Error('network'); };
  const res = await enrichAtlasGraph(baseGraph(), throwing, { batchSize: 10 });
  assert.equal(res.summarized, 0);
  assert.ok(res.batchesFailed >= 1);
});
