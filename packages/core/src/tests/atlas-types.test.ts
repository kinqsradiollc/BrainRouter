import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATLAS_SCHEMA_VERSION,
  isAtlasNode,
  isAtlasEdge,
  isAtlasGraph,
  isAtlasNodeType,
  isAtlasEdgeType,
  atlasFileId,
  atlasSymbolId,
  atlasNodeTypes,
  emptyAtlasGraph,
  type AtlasGraph,
} from '@kinqs/brainrouter-types';

test('ATLAS-1 node ids: canonical file + symbol forms', () => {
  assert.equal(atlasFileId('src/x.ts'), 'file:src/x.ts');
  assert.equal(atlasSymbolId('function', 'src/x.ts', 'foo'), 'function:src/x.ts:foo');
  assert.equal(atlasSymbolId('class', 'src/x.ts', 'Bar'), 'class:src/x.ts:Bar');
});

test('ATLAS-1 type guards accept valid + reject invalid kinds', () => {
  assert.ok(isAtlasNodeType('file') && isAtlasNodeType('domain'));
  assert.ok(!isAtlasNodeType('nope'));
  assert.ok(isAtlasEdgeType('contains') && isAtlasEdgeType('cross_domain'));
  assert.ok(!isAtlasEdgeType('nope'));
  assert.ok(atlasNodeTypes().includes('function'));
});

test('ATLAS-1 isAtlasNode validates required fields', () => {
  assert.ok(isAtlasNode({ id: 'file:a.ts', type: 'file', name: 'a.ts' }));
  assert.ok(isAtlasNode({ id: 'function:a.ts:f', type: 'function', name: 'f', filePath: 'a.ts', lineRange: [1, 9], complexity: 'simple', tags: ['x'] }));
  assert.ok(!isAtlasNode({ id: 'x', type: 'bogus', name: 'x' }));
  assert.ok(!isAtlasNode({ id: 'x', type: 'file' })); // missing name
  assert.ok(!isAtlasNode({ id: 'x', type: 'file', name: 'x', lineRange: [1] })); // bad lineRange
});

test('ATLAS-1 isAtlasEdge validates source/target/type', () => {
  assert.ok(isAtlasEdge({ source: 'a', target: 'b', type: 'imports', weight: 0.9 }));
  assert.ok(!isAtlasEdge({ source: 'a', target: 'b', type: 'bogus' }));
  assert.ok(!isAtlasEdge({ source: 'a', type: 'imports' })); // missing target
});

test('ATLAS-1 emptyAtlasGraph is a well-formed graph; isAtlasGraph round-trips', () => {
  const g = emptyAtlasGraph({ name: 'demo', languages: ['typescript'], analyzedAt: '2026-06-22T00:00:00Z' });
  assert.equal(g.schemaVersion, ATLAS_SCHEMA_VERSION);
  assert.equal(g.kind, 'codebase');
  assert.ok(isAtlasGraph(g));
  const full: AtlasGraph = {
    ...g,
    nodes: [{ id: 'file:a.ts', type: 'file', name: 'a.ts', filePath: 'a.ts' }],
    edges: [{ source: 'file:a.ts', target: 'file:a.ts', type: 'contains' }],
  };
  assert.ok(isAtlasGraph(full));
  assert.ok(!isAtlasGraph({ schemaVersion: 1, project: {}, nodes: [{ bad: true }], edges: [], layers: [], tour: [] }));
});
