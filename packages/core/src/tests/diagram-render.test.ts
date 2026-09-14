/**
 * ADR-056 D-A2 — the deterministic renderer: every fixture renders with all
 * nine checks green; the same document renders byte-identically (and its
 * receipt hashes are the HTML's and the canonical spec's); the HTML is
 * self-contained (no external reference, CSP present, no literal colour
 * outside the token block); a failed check leaves a previous artifact untouched;
 * a structurally invalid document renders nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DIAGRAM_KINDS, type ArchitectureDiagram } from '@kinqs/brainrouter-types';
import {
  renderDiagram,
  deliverDiagram,
  diagramFixture,
  DIAGRAM_CHECK_IDS,
  canonicalDiagramJson,
  layoutDiagram,
  runDiagramChecks,
} from '../diagram/index.js';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

test('D-A2 every fixture renders with all nine checks passing', () => {
  for (const kind of DIAGRAM_KINDS) {
    const r = renderDiagram(diagramFixture(kind));
    assert.equal(r.ok, true, `${kind}: ${JSON.stringify(r.receipt?.checks.filter((c) => !c.ok))}`);
    assert.deepEqual(r.receipt!.checks.map((c) => c.id), [...DIAGRAM_CHECK_IDS]);
    assert.ok(r.html!.includes('<svg'), `${kind}: has svg`);
    assert.ok(r.receipt!.artifact.bytes > 1_000);
  }
});

test('D-A2 rendering is deterministic and the receipt hashes the artifact and the canonical spec', () => {
  const a = renderDiagram(diagramFixture('architecture'));
  const b = renderDiagram(diagramFixture('architecture'));
  assert.equal(a.html, b.html);
  assert.equal(a.receipt!.artifact.sha256, sha(a.html!));
  assert.equal(a.receipt!.specification.sha256, sha(canonicalDiagramJson(a.validation.diagram!)));
  assert.deepEqual(a.receipt, b.receipt);
  assert.ok(!JSON.stringify(a.receipt).match(/\d{4}-\d{2}-\d{2}T/), 'no timestamp in the receipt');
  // Key order in the input does not change the specification hash.
  const reversed = (v: unknown): unknown => Array.isArray(v) ? v.map(reversed)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).reverse().map((k) => [k, reversed((v as Record<string, unknown>)[k])]))
    : v;
  const shuffled = renderDiagram(reversed(diagramFixture('architecture')));
  assert.equal(shuffled.ok, true);
  assert.equal(shuffled.receipt!.specification.sha256, a.receipt!.specification.sha256);
  assert.equal(shuffled.html, a.html, 'key order does not change the artifact either');
});

test('D-A2 the HTML is self-contained: CSP, no external references, colours only in the token block', () => {
  const r = renderDiagram(diagramFixture('architecture'), { theme: 'dark' });
  const html = r.html!;
  assert.ok(html.includes('Content-Security-Policy'));
  assert.ok(!/(?:src|href)=["']https?:/i.test(html));
  assert.ok(html.includes('data-theme="dark"'));
  // Every hex colour lives inside a CSS custom-property declaration.
  const outsideTokens = html.replace(/--dg-[a-z-]+:#[0-9a-f]{3,8}/gi, '');
  assert.ok(!/#[0-9a-f]{6}\b/i.test(outsideTokens), 'literal colour outside the token block');
  assert.ok(html.includes('data-id="api"') && html.includes('data-from="web"'));
  assert.ok(html.includes('id="dg-data"'));
});

test('D-A2 the architecture scene respects hints, boundaries, the main path, and verified beacons', () => {
  const doc = diagramFixture('architecture') as ArchitectureDiagram;
  doc.components[1].evidence = 'verified';
  const r = renderDiagram(doc);
  const scene = r.scene!;
  const web = scene.nodes.find((n) => n.id === 'web')!, api = scene.nodes.find((n) => n.id === 'api')!, db = scene.nodes.find((n) => n.id === 'orders-db')!;
  assert.ok(web.x < api.x && api.x < db.x, 'columns follow the relationship direction');
  assert.ok(web.primary && api.primary && db.primary);
  const vpc = scene.groups.find((g) => g.id === 'vpc')!;
  for (const id of ['api', 'auth', 'orders-db', 'queue']) {
    const n = scene.nodes.find((x) => x.id === id)!;
    assert.ok(n.x >= vpc.x && n.x + n.w <= vpc.x + vpc.w && n.y >= vpc.y && n.y + n.h <= vpc.y + vpc.h, `${id} inside boundary`);
  }
  assert.ok(r.html!.includes('dg-evidence-verified'));
  assert.equal(r.receipt!.evidence, 'mixed');
  // A hinted column wins over layering: `payments` (layered to the last column) pinned to column 0 sits left of `api`.
  const hinted = diagramFixture('architecture') as ArchitectureDiagram;
  hinted.components.find((c) => c.id === 'payments')!.column = 0;
  const s2 = layoutDiagram(hinted);
  assert.ok(s2.nodes.find((n) => n.id === 'payments')!.x < s2.nodes.find((n) => n.id === 'api')!.x, 'an explicit column hint wins');
});

test('D-A2 a check can fail and reports what failed', () => {
  const doc = diagramFixture('architecture') as ArchitectureDiagram;
  const scene = layoutDiagram(doc);
  // Force two nodes onto the same rectangle.
  scene.nodes[1].x = scene.nodes[0].x; scene.nodes[1].y = scene.nodes[0].y;
  const checks = runDiagramChecks(doc, scene, '<html></html>', true);
  const overlap = checks.find((c) => c.id === 'nodes-no-overlap')!;
  assert.equal(overlap.ok, false);
  assert.match(overlap.detail!, /web\/api/);
  const ext = runDiagramChecks(doc, layoutDiagram(doc), '<script src="https://cdn.example/x.js"></script>', true).find((c) => c.id === 'html-self-contained')!;
  assert.equal(ext.ok, false);
});

test('D-A2 deliver writes atomically and a failed delivery keeps the previous artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-diagram-'));
  try {
    const out = path.join(dir, 'map.html');
    const first = deliverDiagram(diagramFixture('sequence'), out);
    assert.equal(first.ok, true);
    assert.ok(fs.existsSync(out) && fs.existsSync(first.receiptPath!));
    const before = fs.readFileSync(out, 'utf8');
    const receipt = JSON.parse(fs.readFileSync(first.receiptPath!, 'utf8'));
    assert.equal(receipt.artifact.sha256, sha(before));
    const broken = diagramFixture('sequence') as unknown as Record<string, unknown>;
    broken.bogus = true;
    const second = deliverDiagram(broken, out);
    assert.equal(second.ok, false);
    assert.equal(second.previousKept, true);
    assert.equal(second.diagnostics[0].code, 'diagram/unknown-field');
    assert.equal(fs.readFileSync(out, 'utf8'), before, 'previous artifact untouched');
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temp file left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D-A2 an invalid document renders nothing', () => {
  const r = renderDiagram({ kind: 'architecture', schemaVersion: 1, meta: { title: 'x' }, components: [], connections: [] });
  assert.equal(r.ok, false);
  assert.equal(r.html, undefined);
  assert.ok(r.validation.diagnostics.length);
});
