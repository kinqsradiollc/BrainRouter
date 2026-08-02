/**
 * ADR-027 D2 — the execution engine is a SETTING, not a migration.
 *
 * Both engines ship. The loop suits open-ended conversational work where the
 * next step depends on what the model just said; the graph suits work with a
 * known shape that must survive interruption. Replacing either with the other
 * trades one real strength for another, so the choice belongs to the operator.
 *
 * The safety property under test: only an explicit 'graph' switches engines. A
 * typo, a stale value, or a missing key must leave every turn on the loop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCliKnobs } from '../config/config.js';

function knobsFor(cli: Record<string, unknown>): { executionEngine: string } {
  return resolveCliKnobs({ cli } as never) as unknown as { executionEngine: string };
}

test('the loop is the default when nothing is configured', () => {
  assert.equal(knobsFor({}).executionEngine, 'loop');
});

test('an explicit graph selection is honoured', () => {
  assert.equal(knobsFor({ executionEngine: 'graph' }).executionEngine, 'graph');
});

test('an explicit loop selection is honoured', () => {
  assert.equal(knobsFor({ executionEngine: 'loop' }).executionEngine, 'loop');
});

test('anything unrecognised falls back to the loop rather than the graph', () => {
  // Failing open to the NEW engine on a typo would change how every turn runs
  // based on a misspelling. The established path is the safe fallback.
  for (const bad of ['Graph', 'GRAPH', 'graphs', 'dag', '', ' graph', null, undefined, 0, 1, {}, []]) {
    assert.equal(
      knobsFor({ executionEngine: bad }).executionEngine,
      'loop',
      `expected loop for ${JSON.stringify(bad)}`,
    );
  }
});
