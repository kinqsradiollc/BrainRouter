import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MANUAL_DEEP_REVIEW_PRESET,
  manualDeepReviewLimitLines,
  manualDeepReviewRequestConfig,
} from './review/deepReviewHost.js';

test('manual deep-review hosts share visible limits below accepted estimates', () => {
  const request = manualDeepReviewRequestConfig();

  assert.notEqual(request, MANUAL_DEEP_REVIEW_PRESET);
  assert.notEqual(request.budgets, MANUAL_DEEP_REVIEW_PRESET.budgets);
  assert.ok(request.budgets.maxModelCalls <= request.telemetryThresholds.maxEstimatedModelCalls);
  assert.ok(request.budgets.maxToolCalls <= request.telemetryThresholds.maxEstimatedToolCalls);
  assert.ok(request.budgets.maxDurationMs <= request.telemetryThresholds.maxEstimatedDurationMs);
  assert.ok(request.budgets.maxUsd <= request.telemetryThresholds.maxEstimatedUsd);
  assert.deepEqual(manualDeepReviewLimitLines().map((line) => line.label), [
    'Preflight',
    'Accepted estimate',
    'Run budget',
    'Context',
  ]);
});

test('manual deep-review request configs cannot mutate the shared preset', () => {
  const first = manualDeepReviewRequestConfig();
  first.budgets.maxModelCalls = 1;
  first.telemetryThresholds.maxRepositoryFiles = 1;

  const second = manualDeepReviewRequestConfig();
  assert.equal(second.budgets.maxModelCalls, 30);
  assert.equal(second.telemetryThresholds.maxRepositoryFiles, 20_000);
});
