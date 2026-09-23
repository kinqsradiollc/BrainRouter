/**
 * ADR-056 D-A5 — the diagram tools and store: `diagram_validate` reports
 * diagnostics; `diagram_render` delivers HTML + spec + receipt under
 * `.brainrouter/diagrams/<slug>` and refuses a slug outside the closed
 * alphabet; an invalid document writes nothing and keeps a previous artifact;
 * both tools are registered with the tiers the registry guard expects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArchitectureDiagram } from '@kinqs/brainrouter-types';
import { builtinToolHandler, type BuiltinToolContext, type BuiltinToolHost } from '../extension/builtin/handlers/index.js';
import { REQUIRED_CORE_TOOL_CATALOG } from '../extension/builtin/toolCatalog.js';
import { BUILTIN_TOOL_SPECS } from '../extension/builtin/toolSpecs.js';
import { diagramFixture, listDiagrams, readDiagramSpec, slugifyDiagramTitle, isDiagramSlug, diagramPaths } from '../diagram/index.js';

const tmpWs = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'br-diagram-tools-'));

async function call(name: string, workspaceRoot: string, args: Record<string, unknown>): Promise<string> {
  const handler = builtinToolHandler(name);
  assert.ok(handler, `${name} is registered`);
  const ctx = { args, invokedName: name, host: { workspaceRoot, sessionKey: 'sess:test' } as unknown as BuiltinToolHost } as unknown as BuiltinToolContext;
  return handler!(ctx);
}

test('D-A5 registry: both tools declared with the expected tiers', () => {
  const validate = REQUIRED_CORE_TOOL_CATALOG.find((t) => t.name === 'diagram_validate')!;
  const render = REQUIRED_CORE_TOOL_CATALOG.find((t) => t.name === 'diagram_render')!;
  assert.equal(validate.accessTier, 'read'); assert.equal(validate.actionKind, 'read_only');
  assert.equal(render.accessTier, 'write'); assert.equal(render.actionKind, 'file_edit'); assert.equal(render.parallelSafe, false);
  for (const name of ['diagram_validate', 'diagram_render']) assert.ok(BUILTIN_TOOL_SPECS.some((s) => s.name === name), `${name} has a spec`);
});

test('D-A5 diagram_validate: clean document says valid; a broken one lists path-prefixed diagnostics', async () => {
  const ws = tmpWs();
  const ok = await call('diagram_validate', ws, { document: diagramFixture('workflow') });
  assert.match(ok, /^Valid workflow diagram — 0 errors, 0 warnings\./);
  const doc = diagramFixture('architecture') as ArchitectureDiagram;
  doc.connections[4].to = 'ghost';
  const bad = await call('diagram_validate', ws, { document: JSON.stringify(doc) });
  assert.match(bad, /^Invalid architecture diagram — 1 errors/);
  assert.match(bad, /\[error\] connections\[4\]\.to — Target "ghost"/);
  assert.match(bad, /fixes: declare the element/);
});

test('D-A5 diagram_render: delivers html + spec + receipt under .brainrouter/diagrams/<slug>', async () => {
  const ws = tmpWs();
  const out = await call('diagram_render', ws, { document: diagramFixture('sequence'), theme: 'dark' });
  assert.match(out, /^Delivered "Create order" \(sequence\) as create-order\./);
  assert.match(out, /checks 9\/9/);
  const p = diagramPaths(ws, 'create-order');
  assert.ok(fs.existsSync(p.html) && fs.existsSync(p.spec) && fs.existsSync(p.receipt));
  assert.ok(fs.readFileSync(p.html, 'utf8').includes('data-theme="dark"'));
  const spec = readDiagramSpec(ws, 'create-order') as { kind: string };
  assert.equal(spec.kind, 'sequence');
  const list = listDiagrams(ws);
  assert.deepEqual(list.map((e) => [e.slug, e.kind, e.title, e.hasHtml, e.hasReceipt]), [['create-order', 'sequence', 'Create order', true, true]]);
  assert.match(out, /Open it with \/diagram open create-order/);
});

test('D-A5 diagram_render: an invalid document is not delivered and a previous artifact is kept', async () => {
  const ws = tmpWs();
  await call('diagram_render', ws, { document: diagramFixture('lifecycle'), slug: 'jobs' });
  const before = fs.readFileSync(diagramPaths(ws, 'jobs').html, 'utf8');
  const broken = diagramFixture('lifecycle') as unknown as Record<string, unknown>;
  broken.extra = 1;
  const out = await call('diagram_render', ws, { document: broken, slug: 'jobs' });
  assert.match(out, /^Not delivered — the previous .*jobs\.html was left untouched\./);
  assert.match(out, /\[error\] extra — Unknown field/);
  assert.equal(fs.readFileSync(diagramPaths(ws, 'jobs').html, 'utf8'), before);
});

test('D-A5 slugs: derived from the title, and anything outside the alphabet is refused', async () => {
  assert.equal(slugifyDiagramTitle('Checkout platform (v2) — Orders!'), 'checkout-platform-v2-orders');
  assert.equal(slugifyDiagramTitle('   '), 'diagram');
  assert.ok(isDiagramSlug('a-b-1') && !isDiagramSlug('../x') && !isDiagramSlug('A') && !isDiagramSlug('-a') && !isDiagramSlug('a/b'));
  const ws = tmpWs();
  await assert.rejects(call('diagram_render', ws, { document: diagramFixture('dataflow'), slug: '../escape' }), /slug "\.\.\/escape" is invalid/);
  assert.ok(!fs.existsSync(path.join(ws, '.brainrouter')));
});
