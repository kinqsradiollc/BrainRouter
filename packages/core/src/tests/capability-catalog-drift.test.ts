/**
 * ADR-046 D1 — generated, drift-checked CAPABILITY catalog.
 *
 * The capability catalog doc (`brainrouter-docs/generated/capability-catalog.md`)
 * is GENERATED from the required-core capability map in code
 * (`requiredCoreCapabilityCatalog()`), never hand-maintained. This test
 * regenerates it and asserts the committed copy is byte-identical, so a tool
 * moved between capabilities, added, or removed in code that doesn't refresh the
 * doc fails CI. Regenerate with `REGEN_CATALOG=1`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requiredCoreCapabilityCatalog } from '../extension/builtin/capabilities.js';
import { REQUIRED_CORE_TOOL_CATALOG } from '../extension/builtin/toolCatalog.js';

const DOC_PATH = fileURLToPath(new URL('../../../../brainrouter-docs/generated/capability-catalog.md', import.meta.url));

function buildCapabilityCatalogMarkdown(): string {
  const capabilities = requiredCoreCapabilityCatalog();
  const names = Object.keys(capabilities).sort();
  const totalTools = names.reduce((n, k) => n + capabilities[k as keyof typeof capabilities].length, 0);
  const rows = names.map((name) => {
    const tools = [...capabilities[name as keyof typeof capabilities]].sort();
    return `| \`${name}\` | ${tools.length} | ${tools.map((t) => `\`${t}\``).join(', ')} |`;
  });
  return [
    '<!-- GENERATED FILE — do not edit by hand.',
    '     Source: packages/core/src/extension/builtin/capabilities.ts (CAPABILITY_TOOLS).',
    '     Regenerate: REGEN_CATALOG=1 npm --workspace packages/core test -- capability-catalog-drift',
    '     Drift-checked by packages/core/src/tests/capability-catalog-drift.test.ts (ADR-046 D1). -->',
    '',
    '# BrainRouter capability catalog',
    '',
    `${names.length} required-core capability extensions activating ${totalTools} built-in tools.`,
    '',
    '| Capability | Tools | Members |',
    '|------------|-------|---------|',
    ...rows,
    '',
  ].join('\n');
}

test('ADR-046 D1 — the generated capability catalog is in sync with source (drift check)', () => {
  const generated = buildCapabilityCatalogMarkdown();
  if (process.env.REGEN_CATALOG === '1') {
    fs.writeFileSync(DOC_PATH, generated, 'utf8');
    return;
  }
  let committed: string;
  try {
    committed = fs.readFileSync(DOC_PATH, 'utf8');
  } catch {
    assert.fail(`generated catalog missing at ${DOC_PATH} — run REGEN_CATALOG=1 to create it`);
    return;
  }
  assert.equal(
    generated,
    committed,
    'brainrouter-docs/generated/capability-catalog.md is stale — a capability/tool mapping changed. Regenerate with REGEN_CATALOG=1.',
  );
});

test('ADR-046 D1 — every capability tool is a real catalog tool, and every catalog tool has a capability', () => {
  const capabilities = requiredCoreCapabilityCatalog();
  const catalogNames = new Set(REQUIRED_CORE_TOOL_CATALOG.map((t) => t.name));
  const mapped = new Map<string, string[]>();
  for (const [capability, tools] of Object.entries(capabilities)) {
    for (const tool of tools) {
      assert.ok(catalogNames.has(tool), `capability "${capability}" names unknown tool "${tool}"`);
      mapped.set(tool, [...(mapped.get(tool) ?? []), capability]);
    }
  }
  // Every catalog tool belongs to exactly one capability.
  for (const tool of catalogNames) {
    const owners = mapped.get(tool) ?? [];
    assert.equal(owners.length, 1, `tool "${tool}" is activated by ${owners.length} capabilities (${owners.join(', ') || 'none'}); expected exactly 1`);
  }
});
