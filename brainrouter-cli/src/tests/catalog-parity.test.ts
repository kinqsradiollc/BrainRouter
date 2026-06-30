import test from 'node:test';
import assert from 'node:assert/strict';
import { SLASH_COMMANDS, HELP_CATEGORIES } from '../cli/repl.js';
import { validateCatalogParity } from '@kinqs/brainrouter-core/dist/command/parity.js';
import { listRoles, loadRegistry } from '@kinqs/brainrouter-core/orchestration';

// T16 GOLDEN — the catalog both heads serve must be internally consistent.
test('catalog parity: SLASH_COMMANDS and /help are in lockstep, no duplicates', () => {
  const r = validateCatalogParity(SLASH_COMMANDS, HELP_CATEGORIES);
  assert.deepEqual(r.errors, [], 'catalog drift detected');
  assert.equal(r.valid, true);
});

test('catalog parity validator flags injected drift (negative control)', () => {
  const r = validateCatalogParity([...SLASH_COMMANDS, '/ghost-command'], HELP_CATEGORIES);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('/ghost-command')), 'undocumented command surfaced');
});

// T16 GOLDEN — agent/role inventory parity: every built-in role maps to a real
// agent definition, and the canonical builtin agent set is present.
test('agent inventory: the five built-in agents load from the builtin tier', () => {
  const builtinIds = loadRegistry().filter((l) => l.source === 'builtin').map((l) => l.def.id).sort();
  for (const id of ['architect', 'explorer', 'reviewer', 'verifier', 'worker']) {
    assert.ok(builtinIds.includes(id), `missing builtin agent: ${id} (have ${builtinIds.join(', ')})`);
  }
});

test('role inventory: every built-in role has a matching agent definition (no orphans)', () => {
  const agentIds = new Set(loadRegistry().map((l) => l.def.id));
  for (const role of listRoles()) {
    assert.ok(agentIds.has(role.name), `role "${role.name}" has no matching agent definition`);
  }
});

test('role inventory: exactly the five canonical roles are built in', () => {
  assert.deepEqual(listRoles().map((r) => r.name).sort(), ['architect', 'explorer', 'reviewer', 'verifier', 'worker']);
});
