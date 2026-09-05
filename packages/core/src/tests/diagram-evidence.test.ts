/**
 * ADR-056 D-A3 — repository evidence: sources that exist at the resolved
 * revision are stamped and their element becomes `verified`; a moved file or
 * an out-of-range line span flips the element to `unverified` with a warning
 * naming the path; a workspace outside any repository says so; the Atlas
 * draft turns layers into typed components with facade sources and named
 * connections, honours the cap, and validates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AtlasGraph, ArchitectureDiagram } from '@kinqs/brainrouter-types';
import { verifyDiagramEvidence, draftDiagramFromAtlas, inferComponentType, validateDiagram, diagramFixture, renderDiagram } from '../diagram/index.js';

function gitRepo(): { root: string; sha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-evidence-'));
  const run = (args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.com']); run(['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');
  run(['add', '.']); run(['commit', '-q', '-m', 'init']);
  return { root, sha: run(['rev-parse', 'HEAD']).stdout.trim() };
}

test('D-A3 sources that exist at HEAD verify; a moved path and a bad range do not, visibly', () => {
  const { root, sha } = gitRepo();
  try {
    const doc = diagramFixture('architecture') as ArchitectureDiagram;
    doc.components[0].sources = [{ path: 'src/a.ts', lines: [1, 5] }];
    doc.components[1].sources = [{ path: 'src/moved.ts' }];
    doc.components[2].sources = [{ path: 'src/b.ts', lines: [1, 50] }];
    const v = verifyDiagramEvidence(doc, root);
    assert.equal(v.revision, sha);
    assert.deepEqual(v.counts, { verified: 1, unverified: 2, unsourced: doc.components.length + doc.connections.length - 3 }, `rev=${v.revision} ${JSON.stringify(v.diagnostics)}`);
    assert.equal(v.ok, false);
    const out = v.diagram as ArchitectureDiagram;
    assert.equal(out.components[0].evidence, 'verified');
    assert.equal(out.components[0].sources![0].revision, sha);
    assert.equal(out.components[1].evidence, 'unverified');
    assert.equal(out.components[2].evidence, 'unverified');
    assert.deepEqual(v.diagnostics.map((d) => [d.code, d.path, d.severity]), [
      ['diagram/evidence-missing-path', 'components[1].sources[0].path', 'warning'],
      ['diagram/evidence-line-range', 'components[2].sources[0].lines', 'warning'],
    ]);
    assert.equal(out.meta.repository?.revision, sha);
    assert.equal(validateDiagram(out).ok, true, 'a stamped document still validates');
    const r = renderDiagram(out);
    assert.equal(r.receipt!.evidence, 'mixed');
    assert.ok(r.html!.includes('dg-evidence-verified'));
    // The input is not mutated: no revision stamped, the fixture's authored state untouched.
    assert.equal(doc.components[0].sources![0].revision, undefined);
    assert.equal(doc.components[1].evidence, 'authored');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('D-A3 an unknown requested revision falls back to HEAD with a warning; a non-repository cannot verify', () => {
  const { root, sha } = gitRepo();
  try {
    const doc = diagramFixture('architecture') as ArchitectureDiagram;
    doc.meta.repository = { revision: 'f'.repeat(40) };
    doc.components[0].sources = [{ path: 'src/a.ts' }];
    const v = verifyDiagramEvidence(doc, root);
    assert.equal(v.revision, sha);
    assert.ok(v.diagnostics.some((d) => d.code === 'diagram/evidence-unknown-revision'));
    assert.equal(v.counts.verified, 1, JSON.stringify(v.diagnostics));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'br-norepo-'));
  try {
    const doc = diagramFixture('architecture') as ArchitectureDiagram;
    doc.components[0].sources = [{ path: 'src/a.ts' }];
    delete doc.components[1].sources; // the fixture's own source would be a second unverified element
    const v = verifyDiagramEvidence(doc, bare);
    assert.equal(v.revision, undefined);
    assert.equal(v.counts.unverified, 1);
    assert.equal(v.diagnostics[0].code, 'diagram/evidence-no-repository');
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

function atlasFixture(layerCount = 3, withLayerEdges = true): AtlasGraph {
  const names = ['API', 'Memory store', 'Desktop UI', 'Auth policy', 'Event bus', 'Deploy', 'Providers', 'Review', 'Planner', 'Track', 'Notes', 'Study', 'Atlas', 'Browser', 'Hooks'];
  const nodes: AtlasGraph['nodes'] = [];
  const layers: AtlasGraph['layers'] = [];
  for (let i = 0; i < layerCount; i++) {
    const files = Array.from({ length: layerCount - i + 1 }, (_, k) => k === 0 ? `src/l${i}/service.ts` : `src/l${i}/f${k}.ts`);
    for (const f of files) nodes.push({ id: `file:${f}`, type: 'file', name: path.basename(f), filePath: f, tags: i === 1 ? ['postgres'] : [] } as AtlasGraph['nodes'][number]);
    layers.push({ id: `layer:${names[i].toLowerCase().replace(/\s+/g, '-')}`, name: names[i], description: `${names[i]} layer`, nodeIds: files.map((f) => `file:${f}`) });
  }
  const edges: AtlasGraph['edges'] = [];
  for (let i = 0; i + 1 < layerCount; i++) edges.push({ source: `file:src/l${i}/service.ts`, target: `file:src/l${i + 1}/service.ts`, type: 'imports' }, { source: `file:src/l${i}/f1.ts`, target: `file:src/l${i + 1}/service.ts`, type: 'imports' });
  const graph: AtlasGraph = {
    schemaVersion: 1,
    project: { name: 'demo', languages: ['typescript'], analyzedAt: '2026-09-05T00:00:00.000Z', gitCommitHash: 'a'.repeat(40) },
    nodes, edges, layers, tour: [],
  };
  if (withLayerEdges) graph.layerEdges = [{ source: 'layer:api', target: 'layer:memory-store', label: 'reads from' }, { source: 'layer:desktop-ui', target: 'layer:api', label: 'calls' }];
  return graph;
}

test('D-A3 draft: layers become typed components with facade sources; layer relationships become labelled connections; it validates', () => {
  const d = draftDiagramFromAtlas(atlasFixture());
  assert.deepEqual(d.diagram.components.map((c) => [c.id, c.type, c.evidence, c.sources?.[0]?.path]), [
    ['api', 'backend', 'authored', 'src/l0/service.ts'],
    ['memory-store', 'database', 'authored', 'src/l1/service.ts'],
    ['desktop-ui', 'frontend', 'authored', 'src/l2/service.ts'],
  ]);
  assert.deepEqual(d.diagram.connections.map((c) => [c.from, c.to, c.label]), [['api', 'memory-store', 'reads from'], ['desktop-ui', 'api', 'calls']]);
  assert.equal(d.diagram.meta.repository?.revision, 'a'.repeat(40));
  assert.equal(validateDiagram(d.diagram).ok, true, JSON.stringify(validateDiagram(d.diagram).diagnostics));
  assert.deepEqual(d.omittedLayers, []);
  assert.ok(d.notes.some((n) => /layer relationships/.test(n)));
});

test('D-A3 draft: without enrichment, connections are counted imports; the cap keeps the largest layers and names the rest', () => {
  const d = draftDiagramFromAtlas(atlasFixture(15, false));
  assert.equal(d.diagram.components.length, 12);
  assert.equal(d.omittedLayers.length, 3);
  assert.ok(d.diagram.connections.every((c) => /^imports \(\d+\)$/.test(c.label ?? '')));
  assert.equal(validateDiagram(d.diagram).ok, true);
  const scoped = draftDiagramFromAtlas(atlasFixture(5), { layers: ['API', 'layer:auth-policy'] });
  assert.deepEqual(scoped.diagram.components.map((c) => c.id), ['api', 'auth-policy']);
  assert.ok(scoped.notes.some((n) => n.startsWith('Out of scope:')));
  const byPrefix = draftDiagramFromAtlas(atlasFixture(5), { pathPrefix: 'src/l3' });
  assert.deepEqual(byPrefix.diagram.components.map((c) => c.id), ['auth-policy']);
});

test('D-A3 component type inference is vocabulary, not proximity', () => {
  assert.equal(inferComponentType('Desktop renderer panels'), 'frontend');
  assert.equal(inferComponentType('Postgres memory store'), 'database');
  assert.equal(inferComponentType('Session delivery inbox'), 'messagebus');
  assert.equal(inferComponentType('Exec policy and sandbox'), 'security');
  assert.equal(inferComponentType('Edge tunnel relay'), 'cloud');
  assert.equal(inferComponentType('GitHub connector'), 'external');
  assert.equal(inferComponentType('Review orchestration'), 'backend');
});
