/**
 * ADR-040 A40-11 — optimization as a governed subgraph.
 *
 * Every test here is a way a self-scoring loop congratulates itself: trading
 * away an unwatched metric, believing its own measurement over an independent
 * check, or steering by a number that stopped moving.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  judgeOptimizationRound,
  arbitrate,
  detectMetricDrift,
  engineeringBuildLoopRound,
  executionDecisionKindFor,
} from '../orchestration/execution/optimizationSubgraph.js';

test('a genuine improvement with nothing else regressing is accepted', () => {
  const verdict = judgeOptimizationRound({
    targetMetricId: 'score',
    counterMetricIds: ['cost'],
    baseline: [{ metricId: 'score', value: 10 }, { metricId: 'cost', value: 5, lowerIsBetter: true }],
    candidate: [{ metricId: 'score', value: 20 }, { metricId: 'cost', value: 5, lowerIsBetter: true }],
  });
  assert.equal(verdict.accept, true);
  assert.ok(verdict.reasonCodes.includes('improved'));
});

test('a counter-metric regression rejects EVEN WHEN the target improved', () => {
  // The whole failure mode: the loop trades away something it was not watching
  // for the number it was.
  const verdict = judgeOptimizationRound({
    targetMetricId: 'score',
    counterMetricIds: ['cost'],
    baseline: [{ metricId: 'score', value: 10 }, { metricId: 'cost', value: 5, lowerIsBetter: true }],
    candidate: [{ metricId: 'score', value: 99 }, { metricId: 'cost', value: 50, lowerIsBetter: true }],
  });
  assert.equal(verdict.accept, false);
  assert.equal(verdict.kind, 'counter-metric');
  assert.ok(verdict.reasonCodes.includes('counter_metric_regressed'));
});

test('the counter-metric is checked BEFORE the target, so the reason is the true one', () => {
  const verdict = judgeOptimizationRound({
    targetMetricId: 'score',
    counterMetricIds: ['cost'],
    baseline: [{ metricId: 'score', value: 10 }, { metricId: 'cost', value: 5, lowerIsBetter: true }],
    candidate: [{ metricId: 'score', value: 1 }, { metricId: 'cost', value: 50, lowerIsBetter: true }],
  });
  assert.equal(verdict.kind, 'counter-metric', 'not "no improvement" — the regression is the story');
});

test('a failed verifier beats a measurement that says yes', () => {
  // The measurement is what the loop optimises, which makes it the least
  // trustworthy witness to its own success.
  const verdict = judgeOptimizationRound({
    targetMetricId: 'score',
    counterMetricIds: [],
    baseline: [{ metricId: 'score', value: 10 }],
    candidate: [{ metricId: 'score', value: 99 }],
    verifierPassed: false,
  });
  assert.equal(verdict.accept, false);
  assert.equal(verdict.kind, 'verifier');
});

test('an unrun verifier is recorded as unverified, not assumed to have passed', () => {
  // "Nobody checked" is not "it is fine".
  const verdict = judgeOptimizationRound({
    targetMetricId: 'score',
    counterMetricIds: [],
    baseline: [{ metricId: 'score', value: 10 }],
    candidate: [{ metricId: 'score', value: 20 }],
  });
  assert.equal(verdict.accept, true);
  assert.ok(verdict.reasonCodes.includes('unverified'));
});

test('no improvement is a rejection, not a neutral outcome', () => {
  const verdict = judgeOptimizationRound({
    targetMetricId: 'score',
    counterMetricIds: [],
    baseline: [{ metricId: 'score', value: 10 }],
    candidate: [{ metricId: 'score', value: 10 }],
  });
  assert.equal(verdict.accept, false);
  assert.equal(verdict.kind, 'measurement');
});

test('lowerIsBetter is honoured, not guessed from the name', () => {
  const verdict = judgeOptimizationRound({
    targetMetricId: 'latency',
    counterMetricIds: [],
    baseline: [{ metricId: 'latency', value: 100, lowerIsBetter: true }],
    candidate: [{ metricId: 'latency', value: 40, lowerIsBetter: true }],
  });
  assert.equal(verdict.accept, true);
});

test('arbitration gives the verifier the win on disagreement', () => {
  // It is the only party with no stake in the number; a tie broken toward the
  // optimiser is not a tie broken at all.
  assert.equal(arbitrate(true, false).accept, false);
  assert.equal(arbitrate(false, true).accept, true);
  assert.ok(arbitrate(true, false).reasonCodes.includes('verifier_wins'));
  assert.equal(arbitrate(true, true).accept, true);
  assert.ok(arbitrate(true, true).reasonCodes.includes('agreed'));
});

test('a metric that stopped moving is flagged as no longer measuring anything', () => {
  const dead = detectMetricDrift([7, 7, 7, 7, 7]);
  assert.equal(dead.accept, false);
  assert.equal(dead.kind, 'drift-audit');
  assert.ok(dead.reasonCodes.includes('metric_not_discriminating'));

  assert.equal(detectMetricDrift([1, 2, 3, 4]).accept, true);
});

test('a short history is not called drift — absence of data is not evidence', () => {
  assert.equal(detectMetricDrift([7, 7]).accept, true);
});

test('the Engineering build loop is one INSTANCE of the general shape', () => {
  // Retained as a compatibility path, expressed in general terms rather than
  // kept as a special case with its own rules.
  const good = engineeringBuildLoopRound({
    passRateBefore: 0.5, passRateAfter: 0.9, lintErrorsBefore: 3, lintErrorsAfter: 1,
  });
  assert.equal(good.accept, true);

  // Tests pass more, lint got worse: the classic trade the loop must refuse.
  const traded = engineeringBuildLoopRound({
    passRateBefore: 0.5, passRateAfter: 0.9, lintErrorsBefore: 3, lintErrorsAfter: 40,
  });
  assert.equal(traded.accept, false);
  assert.equal(traded.kind, 'counter-metric');
});

test('each decision maps onto the shared execution-map vocabulary', () => {
  // So the map can SHOW this behaviour, which is the precondition A40-11 sets
  // for itself.
  assert.equal(executionDecisionKindFor('rollback'), 'rollback');
  assert.equal(executionDecisionKindFor('verifier'), 'guard');
  assert.equal(executionDecisionKindFor('arbitration'), 'selection');
  assert.equal(executionDecisionKindFor('drift-audit'), 'degradation');
});
