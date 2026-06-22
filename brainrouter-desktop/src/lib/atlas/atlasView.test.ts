import test from 'node:test';
import assert from 'node:assert/strict';
import type { AtlasGraph } from '@kinqs/brainrouter-types';
import { atlasViewModel, atlasNodeColor, atlasLayout, atlasNodeSize, atlasNodeFacts, atlasSearchMatches } from './atlasView.js';

function fixture(): AtlasGraph {
  return {
    schemaVersion: 1,
    kind: 'codebase',
    project: { name: 'x', languages: ['typescript'], analyzedAt: '2026-06-22T00:00:00Z' },
    nodes: [
      { id: 'file:a.ts', type: 'file', name: 'a.ts', filePath: 'a.ts' },
      { id: 'file:b.ts', type: 'file', name: 'b.ts', filePath: 'b.ts' },
      { id: 'file:c.ts', type: 'file', name: 'c.ts', filePath: 'c.ts' },
      { id: 'config:pkg', type: 'config', name: 'package.json', filePath: 'package.json' },
      // symbol nodes must NOT appear in the file-level view
      { id: 'function:a.ts:foo', type: 'function', name: 'foo', filePath: 'a.ts', lineRange: [1, 5] },
      { id: 'class:b.ts:Bar', type: 'class', name: 'Bar', filePath: 'b.ts', lineRange: [1, 9] },
    ],
    edges: [
      { source: 'file:a.ts', target: 'file:b.ts', type: 'imports' },
      { source: 'file:a.ts', target: 'file:c.ts', type: 'imports' },
      { source: 'file:b.ts', target: 'file:c.ts', type: 'imports' },
      // contains edges are not import edges → excluded from the structural view
      { source: 'file:a.ts', target: 'function:a.ts:foo', type: 'contains' },
      { source: 'file:b.ts', target: 'class:b.ts:Bar', type: 'contains' },
    ],
    layers: [],
    tour: [],
  };
}

test('atlasViewModel keeps only file-level nodes and import edges', () => {
  const vm = atlasViewModel(fixture());
  const ids = vm.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['config:pkg', 'file:a.ts', 'file:b.ts', 'file:c.ts']);
  // no symbol nodes
  assert.ok(!ids.some((id) => id.startsWith('function:') || id.startsWith('class:')));
  // only the 3 import edges survive (contains edges dropped)
  assert.equal(vm.edges.length, 3);
  assert.ok(vm.edges.every((e) => e.source.startsWith('file:') && e.target.startsWith('file:')));
  assert.equal(vm.total, 4);
  assert.equal(vm.shown, 4);
});

test('atlasViewModel ranks by import-degree and caps to the limit', () => {
  const vm = atlasViewModel(fixture(), 2);
  assert.equal(vm.shown, 2);
  assert.equal(vm.total, 4);
  // a/b/c all have import-degree 2; the cap tie-breaks by id ascending → a, b
  const ids = vm.nodes.map((n) => n.id);
  assert.deepEqual(ids, ['file:a.ts', 'file:b.ts']);
  // edges are pruned to kept nodes
  assert.ok(vm.edges.every((e) => ids.includes(e.source) && ids.includes(e.target)));
  assert.equal(vm.edges.length, 1); // only a.ts -> b.ts is between two kept nodes
});

test('atlasViewModel records degree per node', () => {
  const vm = atlasViewModel(fixture());
  const byId = new Map(vm.nodes.map((n) => [n.id, n.degree]));
  assert.equal(byId.get('file:a.ts'), 2);
  assert.equal(byId.get('file:c.ts'), 2);
  assert.equal(byId.get('file:b.ts'), 2);
  assert.equal(byId.get('config:pkg'), 0);
});

test('atlasNodeColor maps known types and falls back for unknown', () => {
  assert.equal(atlasNodeColor('file'), 'var(--accent, #4c8dff)');
  assert.equal(atlasNodeColor('config'), '#2dd4bf');
  // unknown type → dim fallback
  assert.equal(atlasNodeColor('totally-made-up' as never), 'var(--text-dim, #9d9da6)');
});

test('atlasLayout returns a position for every node and is deterministic', () => {
  const vm = atlasViewModel(fixture());
  const a = atlasLayout(vm, { ticks: 50 });
  const b = atlasLayout(vm, { ticks: 50 });
  for (const n of vm.nodes) {
    const pa = a.get(n.id);
    const pb = b.get(n.id);
    assert.ok(pa && Number.isFinite(pa.x) && Number.isFinite(pa.y), `position for ${n.id}`);
    // d3-force is deterministic without Math.random jitter sources here
    assert.deepEqual(pa, pb);
  }
  assert.equal(a.size, vm.nodes.length);
});

test('atlasNodeSize grows with degree but stays bounded', () => {
  assert.equal(atlasNodeSize(0), 14);
  assert.equal(atlasNodeSize(3), 20);
  assert.equal(atlasNodeSize(1000), 40); // capped
});

test('atlasNodeFacts: symbols, imports in/out, and layer membership', () => {
  const g = fixture();
  g.layers = [{ id: 'layer:core', name: 'Core', nodeIds: ['file:a.ts', 'file:b.ts'] }];

  const a = atlasNodeFacts(g, 'file:a.ts')!;
  assert.equal(a.node.name, 'a.ts');
  assert.deepEqual(a.symbols.map((s) => s.name), ['foo']);
  assert.equal(a.symbols[0].type, 'function');
  // a.ts imports b.ts and c.ts; nothing imports a.ts
  assert.deepEqual(a.importsOut.sort(), ['b.ts', 'c.ts']);
  assert.deepEqual(a.importsIn, []);
  assert.equal(a.layer?.name, 'Core');

  // c.ts is imported by a and b, imports nothing, no layer, no symbols
  const c = atlasNodeFacts(g, 'file:c.ts')!;
  assert.deepEqual(c.importsIn.sort(), ['a.ts', 'b.ts']);
  assert.deepEqual(c.importsOut, []);
  assert.equal(c.layer, undefined);
  assert.equal(c.symbols.length, 0);

  assert.equal(atlasNodeFacts(g, 'file:nope.ts'), null);
});

test('atlasSearchMatches ranks by name, path, summary, tags', () => {
  const g = fixture();
  g.nodes[0].summary = 'the main router'; // file:a.ts
  g.nodes[0].tags = ['entrypoint'];

  assert.deepEqual(atlasSearchMatches(g, ''), []);
  assert.deepEqual(atlasSearchMatches(g, '   '), []);

  // exact symbol-name match
  assert.deepEqual(atlasSearchMatches(g, 'foo'), ['function:a.ts:foo']);

  // name-exact ranks above path-substring
  const ats = atlasSearchMatches(g, 'a.ts');
  assert.equal(ats[0], 'file:a.ts');
  assert.ok(ats.includes('function:a.ts:foo'));

  // summary + tag + config name substring
  assert.ok(atlasSearchMatches(g, 'router').includes('file:a.ts'));
  assert.ok(atlasSearchMatches(g, 'entrypoint').includes('file:a.ts'));
  assert.ok(atlasSearchMatches(g, 'package').includes('config:pkg'));

  // no match
  assert.deepEqual(atlasSearchMatches(g, 'zzzznope'), []);
});
