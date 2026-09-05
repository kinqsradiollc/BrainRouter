/**
 * ADR-056 D-A1 — generated, drift-checked DIAGRAM IR catalog.
 *
 * `brainrouter-docs/generated/diagram-ir.md` is GENERATED from the published
 * JSON Schema (`diagramJsonSchemas()`), never hand-maintained — the same
 * contract as the tool/command/capability catalogs (ADR-046 D1). This test
 * regenerates it and asserts the committed copy is byte-identical, so a field
 * added, renamed, or re-typed in the zod schema that doesn't refresh the doc
 * fails CI. Regenerate with `REGEN_CATALOG=1`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DIAGRAM_KINDS, DIAGRAM_SCHEMA_VERSION } from '@kinqs/brainrouter-types';
import { diagramJsonSchemas } from '../diagram/index.js';

const DOC_PATH = fileURLToPath(new URL('../../../../brainrouter-docs/generated/diagram-ir.md', import.meta.url));

type Frag = Record<string, unknown>;

function resolve(frag: Frag, defs: Record<string, Frag>): Frag {
  const ref = typeof frag.$ref === 'string' ? frag.$ref : undefined;
  return ref ? (defs[ref.replace('#/$defs/', '')] ?? frag) : frag;
}

/** A short, deterministic type label for one schema fragment. */
function typeLabel(fragIn: Frag, defs: Record<string, Frag>): string {
  const frag = resolve(fragIn, defs);
  if (Array.isArray(frag.enum)) return (frag.enum as unknown[]).map((v) => `\`${JSON.stringify(v)}\``).join(' \\| ');
  if (frag.const !== undefined) return `\`${JSON.stringify(frag.const)}\``;
  if (Array.isArray(frag.anyOf)) return (frag.anyOf as Frag[]).map((f) => typeLabel(f, defs)).join(' \\| ');
  if (Array.isArray(frag.prefixItems)) return `tuple[${(frag.prefixItems as Frag[]).map((f) => typeLabel(f, defs)).join(', ')}]`;
  const t = typeof frag.type === 'string' ? frag.type : Array.isArray(frag.type) ? (frag.type as string[]).join('|') : 'any';
  if (t === 'array') return `array<${frag.items ? typeLabel(frag.items as Frag, defs) : 'any'}>`;
  if (t === 'string' && typeof frag.pattern === 'string') return 'string (pattern)';
  return t;
}

function propertyRows(objIn: Frag, defs: Record<string, Frag>): string[] {
  const obj = resolve(objIn, defs);
  const props = (obj.properties ?? {}) as Record<string, Frag>;
  const required = new Set((obj.required as string[] | undefined) ?? []);
  return Object.keys(props).sort().map((name) => `| \`${name}\` | ${typeLabel(props[name], defs)} | ${required.has(name) ? 'yes' : 'no'} |`);
}

/** Deterministically render the catalog markdown from the live schema export. */
function buildDiagramCatalogMarkdown(): string {
  const schemas = diagramJsonSchemas();
  const lines: string[] = [
    '<!-- GENERATED FILE — do not edit by hand.',
    '     Source: packages/core/src/diagram/schema.ts (zod) via diagramJsonSchemas().',
    '     Regenerate: REGEN_CATALOG=1 npm --workspace packages/core test -- diagram-schema-drift',
    '     Drift-checked by packages/core/src/tests/diagram-schema-drift.test.ts (ADR-056 D-A1). -->',
    '',
    '# BrainRouter diagram IR',
    '',
    `Schema version ${DIAGRAM_SCHEMA_VERSION}. ${DIAGRAM_KINDS.length} kinds; every object level rejects unknown fields (\`additionalProperties: false\`).`,
    '',
  ];
  for (const kind of DIAGRAM_KINDS) {
    const schema = schemas[kind] as Frag;
    const defs = (schema.$defs ?? {}) as Record<string, Frag>;
    lines.push(`## \`${kind}\``, '', '| Field | Type | Required |', '|-------|------|----------|', ...propertyRows(schema, defs), '');
    const props = (schema.properties ?? {}) as Record<string, Frag>;
    for (const name of Object.keys(props).sort()) {
      const prop = resolve(props[name], defs);
      const items = prop.items ? resolve(prop.items as Frag, defs) : undefined;
      const target = items?.properties ? items : prop.properties ? prop : undefined;
      if (!target) continue;
      lines.push(`### \`${kind}.${name}\`${items ? ' (array items)' : ''}`, '', '| Field | Type | Required |', '|-------|------|----------|', ...propertyRows(target, defs), '');
    }
  }
  return lines.join('\n');
}

test('ADR-056 D-A1 diagram IR catalog doc matches source (regenerate with REGEN_CATALOG=1)', () => {
  const expected = buildDiagramCatalogMarkdown();
  if (process.env.REGEN_CATALOG) {
    fs.writeFileSync(DOC_PATH, expected);
    return;
  }
  assert.ok(fs.existsSync(DOC_PATH), `missing ${DOC_PATH} — run with REGEN_CATALOG=1`);
  const actual = fs.readFileSync(DOC_PATH, 'utf8');
  assert.equal(actual, expected, 'brainrouter-docs/generated/diagram-ir.md is stale — regenerate with REGEN_CATALOG=1');
});
