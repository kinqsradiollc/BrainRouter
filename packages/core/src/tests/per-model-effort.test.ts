/**
 * ADR-052 P2c (D2) — per-model reasoning-effort defaults. Switching models keeps
 * each model's tuned level: `cli.effortByModel[model]` wins over the session
 * `effort`, while an explicit per-run override still wins over everything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCliKnobs, type Config } from '../config/config.js';
import { effortForTurnSelection } from '../agent/transport/llmTransport.js';

test('resolveCliKnobs sanitizes effortByModel (valid efforts kept, junk dropped)', () => {
  const knobs = resolveCliKnobs({ cli: { effortByModel: { 'opus-5': 'high', 'gpt-5': 'nonsense', '': 'low', 'haiku': 'minimal' } } } as unknown as Config);
  assert.deepEqual(knobs.effortByModel, { 'opus-5': 'high', haiku: 'minimal' });
  assert.deepEqual(resolveCliKnobs({ cli: {} } as unknown as Config).effortByModel, {}, 'absent ⇒ empty map');
});

test('effortForTurnSelection: per-model default wins over the session effort', () => {
  assert.equal(effortForTurnSelection({ effort: 'medium' }, 'opus-5', undefined, 'high'), 'high');
});

test('effortForTurnSelection: session effort is used when no per-model default', () => {
  assert.equal(effortForTurnSelection({ effort: 'low' }, 'opus-5', undefined, undefined), 'low');
});

test('effortForTurnSelection: an explicit override still wins over the per-model default', () => {
  assert.equal(effortForTurnSelection({ effort: 'medium' }, 'opus-5', 'minimal', 'max'), 'minimal');
});
