// ADR-041 A41-11 — the composition dump. Assert the snapshot reflects the real
// registries: non-empty builtin tools / providers / commands, the migrated subset
// is a subset of all builtins, and every list is sorted + deduped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeCompositionSnapshot } from '../runtime/compositionSnapshot.js';

const isSorted = (xs: string[]): boolean => xs.every((x, i) => i === 0 || xs[i - 1] <= x);

test('A41-11 — the snapshot reports non-empty builtin tools, providers, and commands', () => {
  const s = runtimeCompositionSnapshot();
  assert.ok(s.builtinTools.length > 0, 'builtin tools are enumerated');
  assert.ok(s.providers.length > 0, 'the provider catalog is enumerated');
  assert.ok(s.slashCommands.length > 0, 'the slash-command catalog is enumerated');
});

test('A41-11 — the migrated-builtin subset is a subset of all builtin tools', () => {
  const s = runtimeCompositionSnapshot();
  const all = new Set(s.builtinTools);
  for (const name of s.migratedBuiltinTools) {
    assert.ok(all.has(name), `migrated tool ${name} is also a builtin tool`);
  }
});

test('A41-11 — every list is sorted and deduped', () => {
  const s = runtimeCompositionSnapshot();
  for (const [label, list] of Object.entries({
    builtinTools: s.builtinTools,
    migratedBuiltinTools: s.migratedBuiltinTools,
    providers: s.providers,
    slashCommands: s.slashCommands,
  })) {
    assert.ok(isSorted(list), `${label} is sorted`);
    assert.equal(new Set(list).size, list.length, `${label} has no duplicates`);
  }
});

test('A41-11 — the extensions summary shape is present (empty at a cold snapshot)', () => {
  const s = runtimeCompositionSnapshot();
  assert.ok(Array.isArray(s.extensions.tools));
  assert.ok(Array.isArray(s.extensions.providers));
  assert.ok(Array.isArray(s.extensions.panels));
  assert.equal(typeof s.extensions.hooks, 'number');
});
