import test from 'node:test';
import assert from 'node:assert/strict';
import { SLASH_COMMANDS, HELP_CATEGORIES } from '@kinqs/brainrouter-core/command/catalog';
import { validateCatalogParity } from '@kinqs/brainrouter-core/command/parity';
import { buildCommandList, resolveSlashInput, WIRED, WIRE_KINDS, BRIDGE_COMMANDS, type CommandsCatalog } from './commands.js';

// The desktop serves the CLI's OWN catalog; build it the same way the host does.
const catalog: CommandsCatalog = {
  categories: HELP_CATEGORIES as unknown as CommandsCatalog['categories'],
  all: [...SLASH_COMMANDS],
};
const commands = buildCommandList(catalog);

// T16 GOLDEN — the catalog the desktop exposes is drift-free at the boundary.
test('desktop catalog: CLI source has zero command drift', () => {
  const parity = validateCatalogParity(SLASH_COMMANDS, HELP_CATEGORIES);
  assert.deepEqual(parity.errors, []);
});

test('desktop catalog: buildCommandList has no identical rows (same full command twice)', () => {
  // A base may repeat for documented subcommands (e.g. /brain run, /brain status);
  // what must never repeat is the same full `cmd` string — that's a real duplicate.
  const forms = commands.map((c) => c.cmd);
  const dupes = forms.filter((f, i) => forms.indexOf(f) !== i);
  assert.deepEqual([...new Set(dupes)], [], 'identical command rows in the desktop list');
});

// T16 GOLDEN — the central T8 promise: EVERY catalog command routes somewhere
// (native/panel/settings/bridge/cli), never silently to the LLM as "unknown".
test('desktop catalog: every catalog command resolves — never unknown (never the LLM)', () => {
  const unknown = commands
    .map((c) => ({ base: c.base, res: resolveSlashInput(c.base, commands) }))
    .filter(({ res }) => res.kind === 'unknown' || res.kind === 'not-slash');
  assert.deepEqual(unknown.map((u) => u.base), [], 'these commands would fall through to the LLM');
});

test('desktop catalog: every WIRED entry has a valid kind', () => {
  for (const [base, wire] of Object.entries(WIRED)) {
    assert.ok((WIRE_KINDS as readonly string[]).includes(wire.kind), `WIRED["${base}"] has unknown kind "${wire.kind}"`);
  }
});

// T16 GOLDEN — no orphan wiring: a WIRED/bridge entry for a command the CLI no
// longer ships is dead weight and a rename smell. Catch it.
test('desktop catalog: no WIRED entry points at a non-existent command', () => {
  const bases = new Set(commands.map((c) => c.base));
  const orphans = Object.keys(WIRED).filter((base) => !bases.has(base));
  assert.deepEqual(orphans, [], 'WIRED entries with no matching CLI command (rename/removal?)');
});

test('desktop catalog: every bridge command is a real catalog command', () => {
  const bases = new Set(commands.map((c) => c.base));
  const missing = [...BRIDGE_COMMANDS].map((c) => `/${c}`).filter((base) => !bases.has(base));
  assert.deepEqual(missing, [], 'BRIDGE_COMMANDS naming commands the CLI does not ship');
});
