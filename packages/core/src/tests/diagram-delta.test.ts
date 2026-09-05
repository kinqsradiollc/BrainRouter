/**
 * ADR-056 D-A4 — the architecture delta: exact facts (added / removed /
 * rerouted / moved / changed) from canonical documents, order-insensitive and
 * deterministic; a bounded markdown block; a self-contained Before · Delta ·
 * After page with the facts highlighted; the pinned spec at a revision; and
 * the review block that reports only pinned diagrams whose specification
 * changed in the working tree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ArchitectureDiagram, WorkflowDiagram } from '@kinqs/brainrouter-types';
import {
  compareDiagrams,
  diagramDeltaMarkdown,
  renderDiagramDelta,
  readDiagramSpecAtRevision,
  diagramReviewDeltas,
  buildDiagramDeltaContext,
  diagramFixture,
  writeDiagramSpec,
  runDiagramChecks,
  layoutDiagram,
} from '../diagram/index.js';

test('D-A4 identical documents (even with keys reordered) yield no facts and equal hashes', () => {
  const a = diagramFixture('architecture');
  const reversed = JSON.parse(JSON.stringify(a, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, v[k]])) : v)));
  const r = compareDiagrams(a, reversed);
  assert.equal(r.identical, true);
  assert.deepEqual(r.facts, []);
  assert.equal(r.base.sha256, r.head.sha256);
  assert.equal(diagramDeltaMarkdown(r), '');
});

test('D-A4 one moved component and one relabelled connection yield exactly one moved and one changed fact', () => {
  const base = diagramFixture('architecture') as ArchitectureDiagram;
  const head = diagramFixture('architecture') as ArchitectureDiagram;
  head.boundaries![0].wraps = head.boundaries![0].wraps.filter((id) => id !== 'queue'); // queue leaves the private network
  head.connections[0].label = 'HTTPS JSON (v2)';
  const r = compareDiagrams(base, head);
  assert.deepEqual(r.facts.map((f) => [f.kind, f.subject, f.id]), [
    ['moved', 'components', 'queue'],
    ['changed', 'boundaries', 'vpc'],
    ['changed', 'connections', 'c1'],
  ]);
  assert.deepEqual(r.counts, { added: 0, removed: 0, changed: 2, moved: 1, rerouted: 0 });
  const moved = r.facts[0];
  assert.deepEqual(moved.fields, [{ field: 'boundary', before: '"vpc"' }]);
});

test('D-A4 added, removed, rerouted, and a main-path change are each named; evidence state and stamped revisions are not changes', () => {
  const base = diagramFixture('architecture') as ArchitectureDiagram;
  const head = diagramFixture('architecture') as ArchitectureDiagram;
  head.components.push({ id: 'cache', label: 'Cache', type: 'database' });
  head.connections.push({ id: 'c6', label: 'read-through', from: 'api', to: 'cache' });
  head.connections = head.connections.filter((c) => c.id !== 'c5');
  head.connections.find((c) => c.id === 'c4')!.to = 'auth';
  head.mainPath = ['web', 'api', 'auth'];
  head.components[1].evidence = 'verified';
  head.components[1].sources![0].revision = 'a'.repeat(40);
  const r = compareDiagrams(base, head);
  assert.deepEqual(r.facts.map((f) => [f.kind, f.subject, f.id]), [
    ['removed', 'connections', 'c5'],
    ['added', 'components', 'cache'],
    ['added', 'connections', 'c6'],
    ['rerouted', 'connections', 'c4'],
    ['rerouted', 'mainPath', 'mainPath'],
  ]);
  assert.equal(r.facts.find((f) => f.id === 'c4')!.fields![0].field, 'to');
  const md = diagramDeltaMarkdown(r, { slug: 'checkout' });
  assert.match(md, /^### Architecture delta — `checkout` \(architecture: Checkout platform\)/);
  assert.match(md, /1 removed/);
  assert.match(md, /- \*\*rerouted\*\* connections\/c4 \("order\.created"\) — to: "queue" → "auth"/);
  assert.match(md, /evidence, not a finding/);
});

test('D-A4 workflow lanes count as placement; a kind mismatch is refused', () => {
  const base = diagramFixture('workflow') as WorkflowDiagram;
  const head = diagramFixture('workflow') as WorkflowDiagram;
  head.nodes[1].lane = 'human';
  const r = compareDiagrams(base, head);
  assert.deepEqual(r.facts.map((f) => [f.kind, f.id]), [['moved', 'plan']]);
  assert.throws(() => compareDiagrams(diagramFixture('workflow'), diagramFixture('sequence')), /Cannot compare a workflow diagram with a sequence diagram/);
});

test('D-A4 the Before · Delta · After page is self-contained, highlights the facts, ghosts removed elements, and is deterministic', () => {
  const base = diagramFixture('architecture') as ArchitectureDiagram;
  const head = diagramFixture('architecture') as ArchitectureDiagram;
  head.components.push({ id: 'cache', label: 'Cache', type: 'database' });
  head.connections = head.connections.filter((c) => c.id !== 'c5');
  const r = compareDiagrams(base, head);
  const html = renderDiagramDelta(base, head, r, { theme: 'dark' });
  assert.equal(html, renderDiagramDelta(base, head, r, { theme: 'dark' }));
  assert.ok(html.includes('data-id="cache"') && html.includes('dg-delta-added'));
  assert.ok(html.includes('dg-delta-removed'), 'removed connection ghosted on the Before pane');
  assert.ok(!html.includes('<script'), 'no script on the delta page');
  const check = runDiagramChecks(head, layoutDiagram(head), html, true).find((c) => c.id === 'html-self-contained')!;
  assert.equal(check.ok, true);
  assert.ok(html.includes('Content-Security-Policy'));
});

test('D-A4 pinned specs at a revision and the review block: only changed pinned diagrams are reported', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-delta-'));
  const run = (args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    run(['init', '-q']); run(['config', 'user.email', 't@e.com']); run(['config', 'user.name', 'T']);
    writeDiagramSpec(root, 'checkout', diagramFixture('architecture'));
    writeDiagramSpec(root, 'jobs', diagramFixture('lifecycle'));
    run(['add', '.']); run(['commit', '-q', '-m', 'pin']);
    assert.equal(buildDiagramDeltaContext(root), '', 'nothing changed → nothing said');
    assert.ok(readDiagramSpecAtRevision(root, 'HEAD', 'checkout'));
    assert.equal(readDiagramSpecAtRevision(root, 'HEAD', 'missing'), null);
    const head = diagramFixture('architecture') as ArchitectureDiagram;
    head.components.push({ id: 'cache', label: 'Cache', type: 'database' });
    writeDiagramSpec(root, 'checkout', head);
    const deltas = diagramReviewDeltas(root);
    assert.deepEqual(deltas.map((d) => [d.slug, d.receipt.counts.added]), [['checkout', 1]]);
    const block = buildDiagramDeltaContext(root);
    assert.match(block, /### Architecture delta — `checkout`/);
    assert.match(block, /\*\*added\*\* components\/cache/);
    assert.ok(!block.includes('jobs'), 'the unchanged lifecycle is not mentioned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
