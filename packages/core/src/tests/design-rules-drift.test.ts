/**
 * ADR-056 D-B1 — generated, drift-checked DESIGN RULE catalog.
 *
 * `brainrouter-docs/generated/design-rules.md` is GENERATED from `DESIGN_RULES`,
 * never hand-maintained (ADR-046 D1 pattern). A rule added, removed, re-tiered,
 * or reworded in code that doesn't refresh the doc fails CI. Regenerate with
 * `REGEN_CATALOG=1`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DESIGN_RULES, DESIGN_RULES_VERSION } from '../design/index.js';

const DOC_PATH = fileURLToPath(new URL('../../../../brainrouter-docs/generated/design-rules.md', import.meta.url));

function buildMarkdown(): string {
  const cats = ['slop', 'quality', 'design-system'] as const;
  const lines = [
    '<!-- GENERATED FILE — do not edit by hand.',
    '     Source: packages/core/src/design/detect/rules.ts (DESIGN_RULES).',
    '     Regenerate: REGEN_CATALOG=1 npm --workspace packages/core test -- design-rules-drift',
    '     Drift-checked by packages/core/src/tests/design-rules-drift.test.ts (ADR-056 D-B1). -->',
    '',
    '# BrainRouter design rule catalog',
    '',
    `Version ${DESIGN_RULES_VERSION}. ${DESIGN_RULES.length} deterministic rules run by \`design_detect\` / \`/design detect\` with no model. Advisory rules are reported, never counted as failures.`,
    '',
  ];
  for (const cat of cats) {
    const rules = DESIGN_RULES.filter((r) => r.category === cat);
    lines.push(`## \`${cat}\` (${rules.length})`, '', '| Rule | Severity | Name | Guideline |', '|------|----------|------|-----------|');
    for (const r of rules) lines.push(`| \`${r.id}\` | ${r.severity}${r.advisory ? ' (advisory)' : ''} | ${r.name} | ${r.guideline.replace(/\|/g, '\\|')} |`);
    lines.push('');
  }
  return lines.join('\n');
}

test('ADR-056 D-B1 design rule catalog doc matches source (regenerate with REGEN_CATALOG=1)', () => {
  const expected = buildMarkdown();
  if (process.env.REGEN_CATALOG) { fs.writeFileSync(DOC_PATH, expected); return; }
  assert.ok(fs.existsSync(DOC_PATH), `missing ${DOC_PATH} — run with REGEN_CATALOG=1`);
  assert.equal(fs.readFileSync(DOC_PATH, 'utf8'), expected, 'brainrouter-docs/generated/design-rules.md is stale — regenerate with REGEN_CATALOG=1');
});
