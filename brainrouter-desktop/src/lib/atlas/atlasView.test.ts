import test from 'node:test';
import assert from 'node:assert/strict';
import type { AtlasGraph } from '@kinqs/brainrouter-types';
import { atlasViewModel, atlasNodeColor, atlasLayout, atlasNodeSize, atlasNodeFacts, atlasSearchMatches, atlasGrouping, atlasGroupedLayout, capAtlasGroups, atlasOverviewModel, ATLAS_OVERVIEW_OTHER_ID, atlasDomainModel, atlasServiceModel, isServicePortPath, serviceModuleLabel, atlasChangeKind, atlasChangeMap, atlasNodeChanges, atlasImpact, atlasImpactOf, atlasUncoveredFiles, atlasProjectStats, isTestFile } from './atlasView.js';

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

test('atlasGroupedLayout packs large graphs roughly square (no tall column)', () => {
  // 16 groups of 6 files each — without the aspect fix this stacked vertically.
  const groups = Array.from({ length: 16 }, (_, g) => ({
    id: `group:g${g}`, label: `g${g}`, nodeIds: Array.from({ length: 6 }, (_, i) => `file:g${g}/f${i}.ts`),
  }));
  const out = atlasGroupedLayout(groups); // no explicit maxRowWidth → dynamic
  const right = Math.max(...out.groups.map((b) => b.x + b.width));
  const bottom = Math.max(...out.groups.map((b) => b.y + b.height));
  // should be wider-than-or-near-square, never a tall sliver
  assert.ok(right >= bottom * 0.6, `expected roughly square, got ${right}x${bottom}`);
  assert.ok(out.groups.length === 16);
});

test('atlasGroupedLayout fills a wide viewport (no fixed 1080 cap → no tall strip)', () => {
  // Many groups in a WIDE container: the row width should track the viewport,
  // not the old fixed 1080 cap that forced a tall column.
  const groups = Array.from({ length: 30 }, (_, g) => ({
    id: `group:g${g}`, label: `g${g}`, nodeIds: Array.from({ length: 4 }, (_, i) => `file:g${g}/f${i}.ts`),
  }));
  const out = atlasGroupedLayout(groups, { containerWidth: 1600, containerHeight: 700 });
  const right = Math.max(...out.groups.map((b) => b.x + b.width));
  const bottom = Math.max(...out.groups.map((b) => b.y + b.height));
  // The layout targets the viewport ASPECT (fitView scales it), so for a wide
  // viewport it must read as a band — wider than tall — not a vertical strip.
  assert.ok(right > 1080, `wide viewport should spread past the old 1080 cap, got width ${right}`);
  assert.ok(right >= bottom, `wide viewport ⇒ band wider than tall, got ${right}x${bottom}`);
});

test('atlasGroupedLayout: a tall viewport produces a narrower, taller pack (aspect tracks the viewport)', () => {
  const groups = Array.from({ length: 30 }, (_, g) => ({
    id: `group:g${g}`, label: `g${g}`, nodeIds: Array.from({ length: 4 }, (_, i) => `file:g${g}/f${i}.ts`),
  }));
  const wide = atlasGroupedLayout(groups, { containerWidth: 1600, containerHeight: 700 });
  const tall = atlasGroupedLayout(groups, { containerWidth: 800, containerHeight: 1200 });
  const w = (o: typeof wide) => Math.max(...o.groups.map((b) => b.x + b.width));
  // Same groups, wider viewport ⇒ a wider layout than the tall viewport.
  assert.ok(w(wide) > w(tall), `wide ${w(wide)} should exceed tall ${w(tall)}`);
});

test('capAtlasGroups: bounds nodes biggest-first, truncates the crossing group, reports hidden', () => {
  const groups = [
    { id: 'a', label: 'a', nodeIds: ['n1', 'n2', 'n3'] },        // 3
    { id: 'b', label: 'b', nodeIds: ['n4', 'n5', 'n6', 'n7', 'n8'] }, // 5 (biggest)
    { id: 'c', label: 'c', nodeIds: ['n9', 'n10'] },             // 2
  ];
  const capped = capAtlasGroups(groups, 6);
  // total 10 > cap 6 → 4 hidden. Biggest first: b(5) then a → truncated to 1.
  assert.equal(capped.hidden, 4);
  assert.equal(capped.shown, 6);
  assert.equal(capped.groups[0].id, 'b');
  assert.equal(capped.groups[0].nodeIds.length, 5);
  assert.equal(capped.groups[1].id, 'a');
  assert.equal(capped.groups[1].nodeIds.length, 1); // truncated
  assert.equal(capped.hiddenGroups, 1);             // c dropped entirely
  const rendered = capped.groups.reduce((s, g) => s + g.nodeIds.length, 0);
  assert.equal(rendered, 6);
});

test('capAtlasGroups: under-cap and Infinity (drill-in) pass through untouched', () => {
  const groups = [{ id: 'a', label: 'a', nodeIds: ['n1', 'n2'] }];
  assert.deepEqual(capAtlasGroups(groups, 10), { groups, hidden: 0, hiddenGroups: 0, shown: 2 });
  assert.deepEqual(capAtlasGroups(groups, Infinity), { groups, hidden: 0, hiddenGroups: 0, shown: 2 });
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

test('atlasDomainModel: capability cards with entities + flow counts', () => {
  const g = layered();
  // a class in the API layer → an entity; a tour step touching the API layer → a flow
  g.nodes.push({ id: 'class:src/api/server.ts:Server', type: 'class', name: 'Server', filePath: 'src/api/server.ts', lineRange: [1, 9] });
  g.tour = [
    { order: 1, title: 'boot', description: '', nodeIds: ['file:src/api/server.ts'] },
    { order: 2, title: 'data', description: '', nodeIds: ['file:src/db/store.ts'] },
  ];
  const m = atlasDomainModel(g);
  const api = m.cards.find((c) => c.name === 'API')!;
  assert.deepEqual(api.entities, ['Server']);
  assert.equal(api.flows, 1);
  assert.equal(api.fileCount, 2);
  const data = m.cards.find((c) => c.name === 'Data')!;
  assert.deepEqual(data.entities, []);
  assert.equal(data.flows, 1);
  // inter-layer edge preserved
  assert.equal(m.edges.length, 1);
  // no enrichment → no semantic label on the edge
  assert.equal(m.edges[0].label, undefined);
});

test('atlasDomainModel: attaches LLM relationship labels from layerEdges (either direction)', () => {
  const g = layered();
  // enrichment produced a directed label API -> Data; the overview edge is
  // undirected, so the label must attach regardless of orientation.
  g.layerEdges = [{ source: 'layer:api', target: 'layer:data', label: 'persists to' }];
  const m = atlasDomainModel(g);
  assert.equal(m.edges.length, 1);
  assert.equal(m.edges[0].label, 'persists to');

  // a layerEdge for a pair with no structural overview edge does not invent one
  const g2 = layered();
  g2.layerEdges = [{ source: 'layer:api', target: 'layer:nonexistent', label: 'ghost' }];
  const m2 = atlasDomainModel(g2);
  assert.equal(m2.edges.length, 1);
  assert.equal(m2.edges[0].label, undefined);
});

test('atlasImpact: transitive dependents (blast radius) + dependencies + byLayer', () => {
  // server.ts imports routes.ts imports store.ts
  const g = layered();
  const onStore = atlasImpact(g, 'file:src/db/store.ts');
  assert.deepEqual(onStore.directDependents.sort(), ['file:src/api/routes.ts']);
  assert.deepEqual(onStore.dependents.sort(), ['file:src/api/routes.ts', 'file:src/api/server.ts']); // transitive
  assert.deepEqual(onStore.dependencies, []);
  assert.deepEqual(onStore.byLayer, [{ layer: 'API', count: 2 }]); // both dependents are in API

  const onServer = atlasImpact(g, 'file:src/api/server.ts');
  assert.deepEqual(onServer.dependents, []); // nothing imports the entry
  assert.deepEqual(onServer.dependencies.sort(), ['file:src/api/routes.ts', 'file:src/db/store.ts']);

  // changeset impact excludes the changed set itself
  const set = atlasImpactOf(g, ['file:src/db/store.ts']);
  assert.deepEqual(set.dependents.sort(), ['file:src/api/routes.ts', 'file:src/api/server.ts']);
});

test('isTestFile + atlasUncoveredFiles flag code files with no test', () => {
  assert.equal(isTestFile('src/x.test.ts'), true);
  assert.equal(isTestFile('src/__tests__/x.ts'), true);
  assert.equal(isTestFile('src/x.spec.tsx'), true);
  assert.equal(isTestFile('src/x.ts'), false);

  const g = layered();
  // add a test that imports store.ts → store covered; server/routes uncovered
  g.nodes.push({ id: 'file:src/db/store.test.ts', type: 'file', name: 'store.test.ts', filePath: 'src/db/store.test.ts', category: 'code' });
  g.edges.push({ source: 'file:src/db/store.test.ts', target: 'file:src/db/store.ts', type: 'imports' });
  const un = atlasUncoveredFiles(g);
  assert.equal(un.has('file:src/db/store.ts'), false); // imported by a test
  assert.equal(un.has('file:src/api/server.ts'), true); // no test
  assert.equal(un.has('file:src/api/routes.ts'), true);
  assert.equal(un.has('file:src/db/store.test.ts'), false); // the test itself isn't "uncovered"
});

test('atlasChangeKind maps git porcelain codes', () => {
  assert.equal(atlasChangeKind('??'), 'untracked');
  assert.equal(atlasChangeKind('A'), 'added');
  assert.equal(atlasChangeKind('AM'), 'added');
  assert.equal(atlasChangeKind('M'), 'modified');
  assert.equal(atlasChangeKind(' M'), 'modified');
  assert.equal(atlasChangeKind('R'), 'modified');
  assert.equal(atlasChangeKind('D'), 'deleted');
  assert.equal(atlasChangeKind(''), null);
});

test('atlasNodeChanges maps changes to file-level nodes only (not symbols)', () => {
  const g = layered();
  // add a symbol sharing a changed file's path — must NOT be counted
  g.nodes.push({ id: 'class:src/db/store.ts:Store', type: 'class', name: 'Store', filePath: 'src/db/store.ts', lineRange: [1, 9] });
  const map = atlasChangeMap([
    { path: 'src/db/store.ts', status: 'M' },
    { path: 'src/api/server.ts', status: '??' },
    { path: 'does/not/exist.ts', status: 'A' },
  ]);
  const nc = atlasNodeChanges(g, map);
  assert.equal(nc.get('file:src/db/store.ts'), 'modified');
  assert.equal(nc.get('file:src/api/server.ts'), 'untracked');
  assert.equal(nc.has('class:src/db/store.ts:Store'), false); // symbol excluded
  assert.equal(nc.has('does/not/exist.ts'), false);
  assert.equal(nc.size, 2);
});

function serviceFixture(): AtlasGraph {
  return {
    schemaVersion: 1, kind: 'codebase',
    project: { name: 'x', languages: ['typescript'], analyzedAt: '2026-06-22T00:00:00Z' },
    nodes: [
      { id: 'file:src/exec/service.ts', type: 'file', name: 'service.ts', filePath: 'src/exec/service.ts' },
      { id: 'file:src/exec/execPolicy.ts', type: 'file', name: 'execPolicy.ts', filePath: 'src/exec/execPolicy.ts' },
      { id: 'file:src/provider/gateway.ts', type: 'file', name: 'gateway.ts', filePath: 'src/provider/gateway.ts' },
      { id: 'file:src/loose.ts', type: 'file', name: 'loose.ts', filePath: 'src/loose.ts' },
      // a symbol sharing the port's path must not be double-counted
      { id: 'function:src/exec/service.ts:createExecService', type: 'function', name: 'createExecService', filePath: 'src/exec/service.ts', lineRange: [1, 3] },
    ],
    edges: [
      // cross-module import: exec → provider
      { source: 'file:src/exec/service.ts', target: 'file:src/provider/gateway.ts', type: 'imports' },
      // same-module import: no cross edge
      { source: 'file:src/exec/service.ts', target: 'file:src/exec/execPolicy.ts', type: 'imports' },
    ],
    layers: [], tour: [],
  };
}

test('isServicePortPath / serviceModuleLabel', () => {
  assert.equal(isServicePortPath('src/exec/service.ts'), true);
  assert.equal(isServicePortPath('src/provider/gateway.ts'), true);
  assert.equal(isServicePortPath('src/exec/execPolicy.ts'), false);
  assert.equal(serviceModuleLabel('packages/core/src/exec/service.ts'), 'exec');
  assert.equal(serviceModuleLabel('src/memory/tree/service.ts'), 'memory/tree');
});

function manyLayerFixture(n: number): AtlasGraph {
  const nodes: AtlasGraph['nodes'] = [];
  const layers: AtlasGraph['layers'] = [];
  for (let i = 0; i < n; i++) {
    // layer i gets (i+1) files, so sizes are distinct and sortable
    const ids: string[] = [];
    for (let f = 0; f <= i; f++) {
      const id = `file:L${i}_${f}.ts`;
      nodes.push({ id, type: 'file', name: `L${i}_${f}.ts`, filePath: `L${i}_${f}.ts` });
      ids.push(id);
    }
    layers.push({ id: `layer:${i}`, name: `Layer ${i}`, nodeIds: ids });
  }
  return {
    schemaVersion: 1, kind: 'codebase',
    project: { name: 'x', languages: ['typescript'], analyzedAt: '2026-06-22T00:00:00Z' },
    nodes, edges: [], layers, tour: [],
  };
}

test('atlasOverviewModel: default keeps all layers; limit folds the rest into "Other"', () => {
  const g = manyLayerFixture(20);
  assert.equal(atlasOverviewModel(g).cards.length, 20); // default: no rollup

  const m = atlasOverviewModel(g, 5);
  assert.equal(m.cards.length, 5);
  const other = m.cards[m.cards.length - 1];
  assert.equal(other.id, ATLAS_OVERVIEW_OTHER_ID);
  // the 4 biggest layers (19,18,17,16 files) are kept; the other 16 fold in.
  assert.equal(m.cards.slice(0, 4).map((c) => c.fileCount).join(','), '20,19,18,17');
  const totalFiles = manyLayerFixture(20).layers.reduce((s, l) => s + l.nodeIds.length, 0);
  const shownFiles = m.cards.reduce((s, c) => s + c.fileCount, 0);
  assert.equal(shownFiles, totalFiles); // nothing lost in the rollup
  assert.equal(other.description, '16 smaller layers');
});

test('atlasServiceModel builds module cards + cross-module edges', () => {
  const m = atlasServiceModel(serviceFixture());
  const modules = m.cards.map((c) => c.module).sort();
  assert.deepEqual(modules, ['exec', 'provider']);

  const exec = m.cards.find((c) => c.module === 'exec')!;
  assert.equal(exec.portNodeId, 'file:src/exec/service.ts');
  assert.equal(exec.fileCount, 2); // service.ts + execPolicy.ts, NOT the symbol
  assert.ok(exec.nodeIds.includes('file:src/exec/execPolicy.ts'));
  assert.ok(!exec.nodeIds.some((id) => id.startsWith('function:')));

  // one directed edge: exec → provider (same-module import excluded)
  assert.equal(m.edges.length, 1);
  assert.equal(m.edges[0].source, exec.id);
  assert.equal(m.edges[0].weight, 1);
});

test('atlasProjectStats: aggregates counts, languages, frameworks, hotspots', () => {
  const g = layered();
  g.project.frameworks = ['Express'];
  // give files languages + a class for type variety
  g.nodes = g.nodes.map((n) => (n.type === 'file' ? { ...n, language: 'typescript' } : n));
  g.nodes.push({ id: 'class:src/db/store.ts:Store', type: 'class', name: 'Store', filePath: 'src/db/store.ts', lineRange: [1, 9] });

  const s = atlasProjectStats(g);
  assert.equal(s.nodes, g.nodes.length);
  assert.equal(s.edges, g.edges.length);
  assert.equal(s.layers, 2);
  assert.equal(s.files, 3); // server.ts, routes.ts, store.ts (config is not type 'file')
  assert.deepEqual(s.frameworks, ['Express']);
  assert.equal(s.languages.find((l) => l.key === 'typescript')?.count, 3);
  assert.ok(s.byType.find((t) => t.key === 'class')); // class counted
  // store.ts is imported by routes.ts (+ routes by server) → most-connected list non-empty
  assert.ok(s.topConnected.length > 0);
  assert.ok(s.topConnected.every((t) => typeof t.degree === 'number'));
});
