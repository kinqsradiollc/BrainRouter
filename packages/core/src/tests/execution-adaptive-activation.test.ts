/**
 * ADR-040 A40-8 — bounded activation, with the corpus gate still shut.
 *
 * The last test here is the important one. It asserts that this slice did NOT
 * change any profile default, because the gate for that is a corpus that does
 * not exist yet. A test that pins an unbuilt gate closed is the only honest way
 * to land the wiring early.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptiveEligibility,
  adaptiveDiagnostics,
  DEFAULTS_ARE_CORPUS_GATED,
  SAFE_BASELINE_STRATEGY,
} from '../orchestration/execution/adaptiveActivation.js';

const base = { topLevel: true, hasDefinition: true, mode: 'adaptive' } as const;

test('an ordinary top-level adaptive turn is eligible', () => {
  assert.deepEqual(adaptiveEligibility({ ...base }), { eligible: true });
});

test('an explicit user choice is never overridden, and says so first', () => {
  // Checked before every other reason: someone who named a strategy must not be
  // told they were ineligible for an unrelated cause.
  const result = adaptiveEligibility({ ...base, explicitStrategyId: 'deep-review', topLevel: false });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'explicit-strategy');
});

test('a child turn is not eligible — this is a TOP-LEVEL decision', () => {
  assert.equal(adaptiveEligibility({ ...base, topLevel: false }).reason, 'not-top-level');
});

test('a non-adaptive workspace is left alone', () => {
  assert.equal(adaptiveEligibility({ ...base, mode: 'fixed' }).reason, 'not-adaptive-mode');
});

test('goal presence changes NOTHING about eligibility', () => {
  // ADR-040 §0 is explicit: goal presence alone must not enable routing or
  // create a different selection path. Pinned so a later change cannot make a
  // goal quietly mean "route differently".
  const withGoal = adaptiveEligibility({ ...base, goalActive: true });
  const withoutGoal = adaptiveEligibility({ ...base, goalActive: false });
  assert.deepEqual(withGoal, withoutGoal);
});

test('an ineligible turn reports the workspace default, not an adaptive claim', () => {
  const diag = adaptiveDiagnostics({
    eligibility: adaptiveEligibility({ ...base, mode: 'fixed' }),
    selectedStrategyId: 'engineering',
  });
  assert.equal(diag.source, 'workspace-default');
  assert.equal(diag.ineligibilityReason, 'not-adaptive-mode');
});

test('a failed selection falls to direct, and the reason is visible', () => {
  // Every strategy other than direct does MORE — more turns, more tools, more
  // spend. Guessing upward costs the person; guessing downward costs a less
  // clever plan. So uncertainty resolves downward, and says why.
  const diag = adaptiveDiagnostics({
    eligibility: { eligible: true },
    fallbackReason: 'model-timeout',
  });
  assert.equal(diag.strategyId, SAFE_BASELINE_STRATEGY);
  assert.equal(diag.source, 'fallback-direct');
  assert.equal(diag.fallbackReason, 'model-timeout');
});

test('a selection with no strategy is a fallback, not a silent success', () => {
  const diag = adaptiveDiagnostics({ eligibility: { eligible: true }, selectedStrategyId: null });
  assert.equal(diag.strategyId, SAFE_BASELINE_STRATEGY);
  assert.equal(diag.source, 'fallback-direct');
});

test('a successful adaptive selection is reported as adaptive', () => {
  const diag = adaptiveDiagnostics({
    eligibility: { eligible: true },
    selectedStrategyId: 'research',
  });
  assert.equal(diag.strategyId, 'research');
  assert.equal(diag.source, 'adaptive');
  assert.equal(diag.fallbackReason, undefined);
});

test('THE GATE: profile defaults remain corpus-gated, and every path says so', () => {
  // A40-8 forbids changing any profile default until fresh/elliptical/
  // contextless conversation corpora pass. Those corpora do not exist, so this
  // slice ships the wiring with the gate SHUT. If someone flips the constant
  // without the corpus results, this test is what stops it being quiet.
  assert.equal(DEFAULTS_ARE_CORPUS_GATED, true,
    'defaults must stay gated until the A40-8 corpora exist and pass');

  for (const diag of [
    adaptiveDiagnostics({ eligibility: { eligible: true }, selectedStrategyId: 'research' }),
    adaptiveDiagnostics({ eligibility: { eligible: true }, fallbackReason: 'model-error' }),
    adaptiveDiagnostics({ eligibility: adaptiveEligibility({ ...base, mode: 'fixed' }) }),
    adaptiveDiagnostics({ eligibility: { eligible: false }, explicitStrategyId: 'deep-review' }),
  ]) {
    assert.equal(diag.defaultsGated, true, 'every diagnostic surfaces the gate rather than hiding it');
  }
});
