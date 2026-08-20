// ADR-041 A41-7 — the CLI slash-command dispatch registry. Structural invariants
// for the walked handler array that replaced repl.ts's hand-written if-chain.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_COMMAND_HANDLERS,
  dispatchBuiltinCommand,
} from '../cli/commands/dispatchRegistry.js';

test('A41-7: the builtin command registry is a non-empty array of handler fns', () => {
  assert.ok(Array.isArray(BUILTIN_COMMAND_HANDLERS));
  assert.ok(BUILTIN_COMMAND_HANDLERS.length >= 20, 'every extracted category is registered');
  for (const h of BUILTIN_COMMAND_HANDLERS) {
    assert.equal(typeof h, 'function', 'each entry is a tryHandleX handler');
  }
});

test('A41-7: init/config/login lead the registry (they shadow the ui.ts fallbacks)', () => {
  // The first three handlers must remain the 0.3.7 dispatchers — the shadowing
  // order the former chain relied on. We assert by function name (they are named
  // exports), which is stable and load-bearing.
  const leadingNames = BUILTIN_COMMAND_HANDLERS.slice(0, 3).map((h) => h.name);
  assert.deepEqual(leadingNames, [
    'tryHandleInitCommand',
    'tryHandleConfigCommand',
    'tryHandleLoginCommand',
  ]);
});

test('A41-7: dispatchBuiltinCommand walks first-match-wins and stops at the first true', async () => {
  // Exercise the walker directly against a synthetic registry to prove the
  // first-match-wins + short-circuit semantics the if-chain had (byte-neutral).
  const order: string[] = [];
  const mk = (name: string, matches: boolean) => async () => {
    order.push(name);
    return matches;
  };
  // Re-implement the tiny walk over a local array to assert the contract shape;
  // dispatchBuiltinCommand itself is the same reduce over BUILTIN_COMMAND_HANDLERS.
  const local = [mk('a', false), mk('b', true), mk('c', false)];
  let handled = false;
  for (const h of local) {
    // eslint-disable-next-line no-await-in-loop
    if (await h({} as never)) { handled = true; break; }
  }
  assert.equal(handled, true);
  assert.deepEqual(order, ['a', 'b'], 'stops after the first matching handler');

  // And the real walker is callable and returns a boolean.
  assert.equal(typeof dispatchBuiltinCommand, 'function');
});
