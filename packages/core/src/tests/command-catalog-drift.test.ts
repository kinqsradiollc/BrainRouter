/**
 * ADR-046 D1 — generated, drift-checked COMMAND catalog.
 *
 * The command catalog doc (`brainrouter-docs/generated/command-catalog.md`) is
 * GENERATED from the authoritative slash-command surface in code
 * (`SLASH_COMMANDS` + `HELP_CATEGORIES`), never hand-maintained. This test
 * regenerates it and asserts the committed copy is byte-identical, so a command
 * added, recategorized, or re-described in code that doesn't refresh the doc
 * fails CI. It also fails if a `SLASH_COMMANDS` entry has no help documentation
 * (it lands in the "Undocumented" section, which the diff surfaces). Regenerate
 * with `REGEN_CATALOG=1`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SLASH_COMMANDS, HELP_CATEGORIES } from '../command/catalog.js';

const DOC_PATH = fileURLToPath(new URL('../../../../brainrouter-docs/generated/command-catalog.md', import.meta.url));

/** Every `/command` token that appears in a help entry's `cmd` string. */
function commandTokens(cmd: string): string[] {
  return [...cmd.matchAll(/\/[a-z][a-z0-9-]*/gi)].map((m) => m[0]);
}

function cell(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

function buildCommandCatalogMarkdown(): string {
  const documented = new Set<string>();
  const categoryBlocks: string[] = [];
  for (const category of HELP_CATEGORIES) {
    const rows = category.entries.map((e) => {
      for (const tok of commandTokens(e.cmd)) documented.add(tok);
      return `| ${cell(e.cmd)} | ${cell(e.desc)} |`;
    });
    categoryBlocks.push(
      `## ${category.title}`,
      '',
      '| Command | Description |',
      '|---------|-------------|',
      ...rows,
      '',
    );
  }
  const undocumented = [...SLASH_COMMANDS].filter((c) => !documented.has(c)).sort();
  const undocumentedBlock = undocumented.length
    ? ['## Undocumented', '', 'Slash commands with no `/help` entry (fix by adding one to `HELP_CATEGORIES`):', '', undocumented.map((c) => `\`${c}\``).join(' · '), '']
    : ['## Undocumented', '', 'None — every slash command has a help entry.', ''];

  return [
    '<!-- GENERATED FILE — do not edit by hand.',
    '     Source: packages/core/src/command/catalog.ts (SLASH_COMMANDS + HELP_CATEGORIES).',
    '     Regenerate: REGEN_CATALOG=1 npm --workspace packages/core test -- command-catalog-drift',
    '     Drift-checked by packages/core/src/tests/command-catalog-drift.test.ts (ADR-046 D1). -->',
    '',
    '# BrainRouter command catalog',
    '',
    `${SLASH_COMMANDS.length} slash commands across ${HELP_CATEGORIES.length} help categories.`,
    '',
    ...categoryBlocks,
    ...undocumentedBlock,
  ].join('\n');
}

test('ADR-046 D1 — the generated command catalog is in sync with source (drift check)', () => {
  const generated = buildCommandCatalogMarkdown();
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
    'brainrouter-docs/generated/command-catalog.md is stale — a command changed in source. Regenerate with REGEN_CATALOG=1.',
  );
});
