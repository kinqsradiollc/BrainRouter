/**
 * ADR-056 D-A1 — the diagram IR validator: every fixture validates; unknown
 * fields, dangling references, duplicate ids, a broken main path, and an
 * absolute source path fail with a path-prefixed diagnostic; the showcase cap
 * is an error under showcase and a warning under standard; the published JSON
 * Schema is strict at every object level; diagnostics are deterministic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DIAGRAM_KINDS, diagramElementArrays, isDiagramKind, type ArchitectureDiagram, type LifecycleDiagram, type SequenceDiagram } from '@kinqs/brainrouter-types';
import { validateDiagram, diagramJsonSchema, diagramFixture, DIAGRAM_SHOWCASE_MAX_PRIMARY } from '../diagram/index.js';

test('D-A1 every fixture validates under showcase with no diagnostics', () => {
  for (const kind of DIAGRAM_KINDS) {
    const v = validateDiagram(diagramFixture(kind), { quality: 'showcase' });
    assert.equal(v.ok, true, `${kind}: ${JSON.stringify(v.diagnostics)}`);
    assert.equal(v.kind, kind);
    assert.equal(v.diagnostics.length, 0);
    assert.ok(v.diagram, 'the parsed document is returned on success');
  }
});

test('D-A1 an unknown field fails with its JSON path', () => {
  const doc = diagramFixture('architecture') as ArchitectureDiagram & { components: Array<Record<string, unknown>> };
  doc.components[0].colour = '#fff';
  const v = validateDiagram(doc);
  assert.equal(v.ok, false);
  assert.equal(v.diagram, undefined);
  const d = v.diagnostics.find((x) => x.code === 'diagram/unknown-field');
  assert.ok(d, JSON.stringify(v.diagnostics));
  assert.equal(d.path, 'components[0].colour');
  assert.equal(d.severity, 'error');
});

test('D-A1 an unknown top-level and meta field are both reported', () => {
  const doc = diagramFixture('workflow') as unknown as Record<string, unknown>;
  doc.bogus = 1;
  (doc.meta as Record<string, unknown>).theme_name = 'x';
  const v = validateDiagram(doc);
  const paths = v.diagnostics.map((d) => d.path).sort();
  assert.deepEqual(paths, ['bogus', 'meta.theme_name']);
});

test('D-A1 a dangling relationship endpoint is an unresolved reference at the endpoint path', () => {
  const doc = diagramFixture('architecture') as ArchitectureDiagram;
  // c5 (queue → payments) is off the main path, so only the reference itself is wrong.
  doc.connections[4].to = 'nowhere';
  const v = validateDiagram(doc);
  assert.equal(v.ok, false);
  assert.deepEqual(v.diagnostics.map((d) => [d.code, d.path]), [
    ['diagram/unresolved-reference', 'connections[4].to'],
  ]);
  assert.ok(v.diagnostics[0].supportedFixes?.length);
});

test('D-A1 duplicate ids across element arrays are errors that name the first declaration', () => {
  const doc = diagramFixture('architecture') as ArchitectureDiagram;
  doc.connections[1].id = 'web';
  const v = validateDiagram(doc);
  const d = v.diagnostics.find((x) => x.code === 'diagram/duplicate-id');
  assert.ok(d);
  assert.equal(d.path, 'connections[1].id');
  assert.match(d.message, /components\[0\]\.id/);
});

test('D-A1 a main path whose consecutive elements are not connected is broken', () => {
  const doc = diagramFixture('architecture') as ArchitectureDiagram;
  doc.mainPath = ['web', 'payments'];
  const v = validateDiagram(doc);
  assert.deepEqual(v.diagnostics.map((d) => [d.code, d.path]), [['diagram/main-path-broken', 'mainPath[1]']]);
});

test('D-A1 the showcase primary cap is an error under showcase and a warning under standard', () => {
  const doc = diagramFixture('architecture') as ArchitectureDiagram;
  for (let i = doc.components.length; i <= DIAGRAM_SHOWCASE_MAX_PRIMARY; i++) {
    doc.components.push({ id: `extra-${i}`, label: `Extra ${i}`, type: 'backend' });
  }
  assert.ok(doc.components.length > DIAGRAM_SHOWCASE_MAX_PRIMARY);
  const showcase = validateDiagram(doc, { quality: 'showcase' });
  assert.equal(showcase.ok, false);
  assert.equal(showcase.diagnostics[0].severity, 'error');
  const standard = validateDiagram(doc, { quality: 'standard' });
  assert.equal(standard.ok, true, 'a warning does not fail a standard-profile document');
  assert.equal(standard.warningCount, 1);
  assert.equal(standard.diagnostics[0].path, 'components');
});

test('D-A1 a source path must be repo-relative POSIX; a revision must be a full sha', () => {
  const doc = diagramFixture('architecture') as ArchitectureDiagram;
  doc.components[1].sources = [{ path: '/etc/passwd' }, { path: '../up.ts' }, { path: 'ok.ts', revision: 'abc' }];
  const v = validateDiagram(doc);
  assert.equal(v.ok, false);
  assert.deepEqual(v.diagnostics.map((d) => d.path), [
    'components[1].sources[0].path',
    'components[1].sources[1].path',
    'components[1].sources[2].revision',
  ]);
});

test('D-A1 lifecycle: exactly one initial state when states are typed; an activation must run forward', () => {
  const life = diagramFixture('lifecycle') as LifecycleDiagram;
  life.states[1].type = 'initial';
  const v1 = validateDiagram(life);
  assert.deepEqual(v1.diagnostics.map((d) => d.code), ['diagram/initial-state']);
  const seq = diagramFixture('sequence') as SequenceDiagram;
  seq.activations = [{ participant: 'api', fromMessage: 'm4', toMessage: 'm1' }];
  const v2 = validateDiagram(seq);
  assert.deepEqual(v2.diagnostics.map((d) => [d.code, d.path]), [['diagram/activation-order', 'activations[0]']]);
});

test('D-A1 an unknown kind fails closed and names the accepted kinds', () => {
  const v = validateDiagram({ kind: 'mindmap' });
  assert.equal(v.ok, false);
  assert.equal(v.diagnostics[0].code, 'diagram/unknown-kind');
  assert.equal(v.diagnostics[0].supportedFixes?.length, DIAGRAM_KINDS.length);
  assert.equal(validateDiagram(null).ok, false);
  assert.equal(validateDiagram('architecture').ok, false);
});

test('D-A1 diagnostics are sorted by path so two runs read identically', () => {
  const doc = diagramFixture('architecture') as ArchitectureDiagram;
  doc.connections[4].to = 'zzz';
  doc.connections[0].from = 'aaa';
  doc.mainPath = ['web', 'payments'];
  const a = validateDiagram(doc).diagnostics.map((d) => d.path);
  const b = validateDiagram(structuredClone(doc)).diagnostics.map((d) => d.path);
  assert.deepEqual(a, b);
  assert.deepEqual(a, [...a].sort((x, y) => x.localeCompare(y)));
});

test('D-A1 the published JSON Schema is strict at the root and in every element item', () => {
  for (const kind of DIAGRAM_KINDS) {
    const schema = diagramJsonSchema(kind) as { additionalProperties?: boolean; required?: string[]; properties: Record<string, { items?: { additionalProperties?: boolean; $ref?: string } }>; $defs?: Record<string, { additionalProperties?: boolean }> };
    assert.equal(schema.additionalProperties, false, `${kind}: root`);
    for (const key of ['schemaVersion', 'kind', 'meta']) assert.ok(schema.required?.includes(key), `${kind}: ${key} required`);
    for (const arrayName of diagramElementArrays(kind)) {
      const prop = schema.properties[arrayName];
      assert.ok(prop, `${kind}: ${arrayName} declared`);
      const items = prop.items ?? {};
      const target = items.$ref ? schema.$defs?.[items.$ref.replace('#/$defs/', '')] : items;
      assert.equal(target?.additionalProperties, false, `${kind}: ${arrayName} items strict`);
    }
  }
});

test('D-A1 type guards', () => {
  assert.ok(isDiagramKind('sequence'));
  assert.ok(!isDiagramKind('erd'));
  assert.deepEqual(diagramElementArrays('lifecycle'), ['states', 'transitions']);
});
