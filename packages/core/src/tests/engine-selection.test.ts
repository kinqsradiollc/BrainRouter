/**
 * ADR-028 C1 — the parity matrix.
 *
 * The ADR requires parity to be ASSERTED, not assumed: the same capabilities
 * through both engines, failing when one supports something the other does not.
 * Without that, "both ship" decays into "one ships and one exists" — which is
 * exactly what happened, for two releases, unnoticed.
 *
 * So these tests are deliberately awkward. The parity test below FAILS today,
 * by design, if you delete the gap check — it encodes that graph is not yet an
 * equal choice, and it will start demanding parity the moment someone claims it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_CAPABILITIES,
  REQUIRED_CAPABILITIES,
  capabilityGap,
  isEngineReady,
  selectEngine,
  describeRunningEngine,
  type EngineKind,
} from '../agent/runtime/engineSelection.js';

test('every engine declares every required capability — no silent omissions', () => {
  // A missing key would read as `undefined`, which is falsy, which would look
  // like an honest "no" while actually being an oversight.
  for (const engine of ['loop', 'graph'] as EngineKind[]) {
    for (const cap of REQUIRED_CAPABILITIES) {
      assert.equal(
        typeof ENGINE_CAPABILITIES[engine][cap],
        'boolean',
        `${engine} must state ${cap} explicitly`,
      );
    }
  }
});

test('the loop is ready; it is the baseline the other engine is measured against', () => {
  assert.deepEqual(capabilityGap('loop'), []);
  assert.equal(isEngineReady('loop'), true);
});

test('PARITY — graph is not yet an equal choice, and the gap is named', () => {
  // This test is the point of C1. When someone finishes the graph path they
  // will have to come here and delete this, which is the moment parity gets
  // claimed deliberately rather than assumed by default.
  const gap = capabilityGap('graph');
  assert.ok(gap.length > 0, 'if this passes, update ENGINE_CAPABILITIES and flip this assertion');
  assert.ok(gap.includes('interrupts'));
  assert.ok(gap.includes('toolAuthorization'));
  assert.equal(isEngineReady('graph'), false);
});

test('graph earns its keep on resumability — the reason it was not deleted', () => {
  // The ADR rejected deleting the knob because this is real: the executor
  // checkpoints at node boundaries and requires idempotency keys.
  assert.equal(ENGINE_CAPABILITIES.graph.resumable, true);
  assert.equal(ENGINE_CAPABILITIES.loop.resumable, false);
});

test('selecting an incomplete engine falls back AND says so', () => {
  // Neither silently honoured (you would lose interrupts without being told)
  // nor silently ignored (the bug this decision exists to fix).
  const s = selectEngine('graph');
  assert.equal(s.engine, 'loop');
  assert.equal(s.requested, 'graph');
  assert.match(s.notice!, /does not yet support/);
  assert.match(s.notice!, /interrupts/);
});

test('selecting the loop is honoured without a notice', () => {
  const s = selectEngine('loop');
  assert.equal(s.engine, 'loop');
  assert.equal(s.notice, undefined);
});

test('development mode runs the incomplete engine, still saying what is missing', () => {
  // The people building the graph path need to run it BECAUSE it is incomplete.
  const s = selectEngine('graph', { allowIncomplete: true });
  assert.equal(s.engine, 'graph');
  assert.match(s.notice!, /development mode/);
  assert.ok(s.gap.length > 0);
});

test('the session label names the engine that ACTUALLY ran', () => {
  // A setting whose effect is invisible is one nobody trusts they changed.
  assert.equal(describeRunningEngine(selectEngine('loop')), 'Engine: loop');
  assert.equal(describeRunningEngine(selectEngine('graph')), 'Engine: loop (graph requested)');
  assert.equal(
    describeRunningEngine(selectEngine('graph', { allowIncomplete: true })),
    'Engine: graph',
  );
});
