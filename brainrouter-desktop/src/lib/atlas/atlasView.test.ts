import test from 'node:test';
import assert from 'node:assert/strict';
import type { AtlasGraph } from '@kinqs/brainrouter-types';
import { atlasViewModel, atlasNodeColor, atlasLayout, atlasNodeSize, atlasNodeFacts, atlasSearchMatches, atlasGrouping, atlasGroupedLayout, atlasOverviewModel } from './atlasView.js';

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

function layered(): AtlasGraph {
  return {
    schemaVersion: 1, kind: 'codebase',
    project: { name: 'x', languages: ['typescript'], analyzedAt: '2026-06-22T00:00:00Z' },
    nodes: [
      { id: 'file:src/api/server.ts', type: 'file', name: 'server.ts', filePath: 'src/api/server.ts', category: 'code', complexity: 'complex' },
      { id: 'file:src/api/routes.ts', type: 'file', name: 'routes.ts', filePath: 'src/api/routes.ts', category: 'code', complexity: 'moderate' },
      { id: 'file:src/db/store.ts', type: 'file', name: 'store.ts', filePath: 'src/db/store.ts', category: 'code', complexity: 'simple' },
      { id: 'config:package.json', type: 'config', name: 'package.json', filePath: 'package.json', category: 'config', complexity: 'simple' },
    ],
    edges: [
      { source: 'file:src/api/routes.ts', target: 'file:src/db/store.ts', type: 'imports' },
      { source: 'file:src/api/server.ts', target: 'file:src/api/routes.ts', type: 'imports' },
    ],
    layers: [
      { id: 'layer:api', name: 'API', nodeIds: ['file:src/api/server.ts', 'file:src/api/routes.ts'] },
      { id: 'layer:data', name: 'Data', nodeIds: ['file:src/db/store.ts'] },
    ],
    tour: [],
  };
}

test('atlasGrouping: by layer (with Other for orphans) and by directory fallback', () => {
  const g = layered();
  const byLayer = atlasGrouping(g);
  assert.deepEqual(byLayer.map((x) => x.label), ['API', 'Data', 'Other']); // package.json is unlayered → Other
  assert.deepEqual(byLayer.find((x) => x.label === 'Other')!.nodeIds, ['config:package.json']);

  // no layers → group by directory, largest first
  const g2 = { ...g, layers: [] };
  const byDir = atlasGrouping(g2);
  assert.ok(byDir.some((x) => x.label === 'src/api' && x.nodeIds.length === 2));
  assert.ok(byDir.some((x) => x.label === 'src/db'));
});

test('atlasGrouping: scope restricts membership', () => {
  const g = layered();
  const groups = atlasGrouping(g, new Set(['file:src/db/store.ts']));
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].nodeIds, ['file:src/db/store.ts']);
});

test('atlasGroupedLayout: child positions relative to packed group boxes', () => {
  const groups = atlasGrouping(layered());
  const out = atlasGroupedLayout(groups, { maxRowWidth: 99999 });
  // every node mapped to a group + a relative position
  for (const g of groups) for (const id of g.nodeIds) {
    assert.ok(out.positions.has(id), `pos ${id}`);
    assert.equal(out.groupOf.get(id), g.id);
  }
  // boxes are sized and laid out left-to-right (single row here), non-overlapping x
  const boxes = out.groups;
  assert.equal(boxes.length, groups.length);
  for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].x >= boxes[i - 1].x + boxes[i - 1].width, 'no x overlap');
  assert.ok(boxes.every((b) => b.width > 0 && b.height > 0));
});

test('atlasOverviewModel: layer cards + inter-layer edges', () => {
  const m = atlasOverviewModel(layered());
  assert.deepEqual(m.cards.map((c) => c.name), ['API', 'Data']);
  const api = m.cards.find((c) => c.name === 'API')!;
  assert.equal(api.fileCount, 2);
  assert.equal(api.complexity, 'complex'); // server.ts is complex
  // routes.ts (API) imports store.ts (Data) → one inter-layer edge
  assert.equal(m.edges.length, 1);
  assert.equal(m.edges[0].weight, 1);
});
