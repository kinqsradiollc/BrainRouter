/**
 * ADR-041 A41-16 (W4) — generated, drift-checked catalog.
 *
 * The tool catalog doc (`brainrouter-docs/generated/tool-catalog.md`) is GENERATED
 * from source (`BUILTIN_TOOL_SPECS` + `REQUIRED_CORE_TOOL_CATALOG` + `SLASH_COMMANDS`),
 * never hand-maintained. This test regenerates it and asserts the committed copy is
 * byte-identical — so a tool/command added, retiered, or re-described in code that
 * doesn't refresh the doc fails CI. Regenerate with `REGEN_CATALOG=1` in the env.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUILTIN_TOOL_SPECS } from '../extension/builtin/toolSpecs.js';
import { REQUIRED_CORE_TOOL_CATALOG } from '../extension/builtin/toolCatalog.js';
import { SLASH_COMMANDS } from '../command/catalog.js';

const DOC_PATH = fileURLToPath(new URL('../../../../brainrouter-docs/generated/tool-catalog.md', import.meta.url));

/** First sentence / line of a description, trimmed for a one-line table cell. */
function oneLine(text: unknown): string {
  const s = typeof text === 'string' ? text : '';
  const firstLine = s.replace(/\s+/g, ' ').trim();
  const dot = firstLine.indexOf('. ');
  return (dot > 0 ? firstLine.slice(0, dot + 1) : firstLine).replace(/\|/g, '\\|');
}

/** Deterministically render the catalog markdown from the live source exports. */
function buildToolCatalogMarkdown(): string {
  const specByName = new Map(
    (BUILTIN_TOOL_SPECS as Array<{ name?: string; description?: string }>)
      .filter((s): s is { name: string; description?: string } => typeof s?.name === 'string')
      .map((s) => [s.name, s]),
  );
  const rows = [...REQUIRED_CORE_TOOL_CATALOG]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const desc = oneLine(specByName.get(entry.name)?.description);
      return `| \`${entry.name}\` | ${entry.accessTier} | ${entry.actionKind} | ${entry.parallelSafe ? 'yes' : 'no'} | ${desc} |`;
    });
  const commands = [...SLASH_COMMANDS].sort().map((c) => `\`${c}\``).join(' · ');

  return [
    '<!-- GENERATED FILE — do not edit by hand.',
    '     Source: packages/core/src/extension/builtin/{toolSpecs,toolCatalog}.ts + command/catalog.ts.',
    '     Regenerate: REGEN_CATALOG=1 npm --workspace packages/core test -- tool-catalog-drift',
    '     Drift-checked by packages/core/src/tests/tool-catalog-drift.test.ts (ADR-041 A41-16). -->',
    '',
    '# BrainRouter tool catalog',
    '',
    `${REQUIRED_CORE_TOOL_CATALOG.length} built-in agent tools, by access tier and action kind.`,
    '',
    '| Tool | Tier | Action kind | Parallel-safe | Description |',
    '|------|------|-------------|---------------|-------------|',
    ...rows,
    '',
    '## Slash commands',
    '',
    commands,
    '',
  ].join('\n');
}

test('A41-16 — the generated tool catalog is in sync with source (drift check)', () => {
  const generated = buildToolCatalogMarkdown();
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
    'brainrouter-docs/generated/tool-catalog.md is stale — a tool/command changed in source. Regenerate with REGEN_CATALOG=1.',
  );
});
