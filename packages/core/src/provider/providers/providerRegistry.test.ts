import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from './providerRegistry.js';
import type { ProviderDefinition } from './definition.js';

const def = (id: string, label = id): ProviderDefinition => ({ id, label } as ProviderDefinition);

test('ADR-041 D1: builtin reads match the former ReadonlyMap surface', () => {
  const r = new ProviderRegistry([def('a'), def('b')]);
  assert.equal(r.get('a')?.id, 'a');
  assert.equal(r.has('a'), true);
  assert.equal(r.has('z'), false);
  assert.equal(r.hasBuiltin('a'), true);
});

test('ADR-041 D1: register is live to reads; dispose removes it', () => {
  const r = new ProviderRegistry([def('a')]);
  assert.equal(r.get('x'), undefined);
  const h = r.register(def('x', 'X'));
  assert.equal(r.get('x')?.label, 'X');
  assert.equal(r.has('x'), true);
  assert.equal(r.hasBuiltin('x'), false); // a runtime registration, not a builtin
  h.dispose();
  assert.equal(r.get('x'), undefined);
  assert.equal(r.has('x'), false);
});

test('ADR-041 D1: register shadows a builtin; dispose restores the builtin', () => {
  const r = new ProviderRegistry([def('a', 'builtin-a')]);
  const h = r.register(def('a', 'override-a'));
  assert.equal(r.get('a')?.label, 'override-a');
  assert.equal(r.hasBuiltin('a'), true);
  h.dispose();
  assert.equal(r.get('a')?.label, 'builtin-a');
});

test('ADR-041 D1: replace swaps; dispose is idempotent; entries merge', () => {
  const r = new ProviderRegistry([def('a')]);
  r.replace(def('a', 'replaced'));
  assert.equal(r.get('a')?.label, 'replaced');
  const h = r.register(def('b'));
  assert.deepEqual([...r.entries()].map(([id]) => id).sort(), ['a', 'b']);
  h.dispose(); h.dispose();
  assert.equal(r.has('b'), false);
});

test('ADR-041 D1: setExtensionProviders makes extension providers live to routing', () => {
  const r = new ProviderRegistry([def('builtin-a', 'A')]);
  assert.equal(r.get('ext-x'), undefined);
  r.setExtensionProviders([def('ext-x', 'X'), def('ext-y', 'Y')]);
  assert.equal(r.get('ext-x')?.label, 'X');
  assert.equal(r.has('ext-y'), true);
  assert.equal(r.hasBuiltin('ext-x'), false);         // an extension is not a builtin
  // wholesale replace: dropping ext-y removes it
  r.setExtensionProviders([def('ext-x', 'X')]);
  assert.equal(r.has('ext-y'), false);
  assert.equal(r.get('ext-x')?.label, 'X');
});

test('ADR-041 D1: a builtin id wins over an extension of the same id; explicit register wins over both', () => {
  const r = new ProviderRegistry([def('shared', 'builtin')]);
  r.setExtensionProviders([def('shared', 'extension')]);
  assert.equal(r.get('shared')?.label, 'builtin');    // builtin authoritative over extension
  const h = r.register(def('shared', 'runtime'));
  assert.equal(r.get('shared')?.label, 'runtime');    // explicit runtime override wins
  h.dispose();
  assert.equal(r.get('shared')?.label, 'builtin');    // back to builtin, extension still shadowed
});
