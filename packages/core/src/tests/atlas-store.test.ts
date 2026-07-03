import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate state under a throwaway home (same pattern as usage-history.test).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'br-atlas-store-'));
process.env.BRAINROUTER_HOME = TMP;

const { saveAtlasGraph, readAtlasGraph, atlasGraphStats, atlasGraphFile } = await import('../atlas/store/atlasStore.js');
const { emptyAtlasGraph } = await import('@kinqs/brainrouter-types');

test('ATLAS-3 atlasStore round-trips a graph per workspace + computes stats', () => {
  const ws = path.join(TMP, 'ws-demo');
  fs.mkdirSync(ws, { recursive: true }); // workspace dir must exist (getStateDir resolves its real path)
  assert.equal(readAtlasGraph(ws), null, 'no atlas before a build');

  const g = emptyAtlasGraph({ name: 'demo', languages: ['typescript'], analyzedAt: '2026-06-22T00:00:00Z' });
  g.nodes.push(
    { id: 'file:a.ts', type: 'file', name: 'a.ts', filePath: 'a.ts' },
    { id: 'function:a.ts:f', type: 'function', name: 'f', filePath: 'a.ts' },
    { id: 'class:a.ts:C', type: 'class', name: 'C', filePath: 'a.ts' },
  );
  g.edges.push({ source: 'file:a.ts', target: 'function:a.ts:f', type: 'contains' });
  saveAtlasGraph(ws, g);

  const back = readAtlasGraph(ws);
  assert.ok(back, 'reads back the saved graph');
  assert.equal(back!.nodes.length, 3);

  const s = atlasGraphStats(back!);
  assert.equal(s.files, 1);
  assert.equal(s.functions, 1);
  assert.equal(s.classes, 1);
  assert.equal(s.edges, 1);
  assert.equal(s.enriched, false, 'a structural-only graph is not enriched');
});

test('ATLAS-3 atlasGraphStats marks an enriched graph', () => {
  const g = emptyAtlasGraph({ name: 'demo', languages: [], analyzedAt: '2026-06-22T00:00:00Z' });
  g.nodes.push({ id: 'file:a.ts', type: 'file', name: 'a.ts', summary: 'entry point' });
  assert.equal(atlasGraphStats(g).enriched, true);
});

test('ATLAS-3 readAtlasGraph returns null for a malformed artifact', () => {
  const ws = path.join(TMP, 'ws-bad');
  fs.mkdirSync(ws, { recursive: true });
  const file = atlasGraphFile(ws);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"not":"a graph"}');
  assert.equal(readAtlasGraph(ws), null);
});
