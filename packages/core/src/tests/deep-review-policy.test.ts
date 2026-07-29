import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeepReviewPolicy,
  evaluateDeepReviewActivation,
  parseDeepReviewPolicy,
} from '../review/domain/deepReviewPolicy.js';

function policy(program: 'code_review' | 'security_review' = 'security_review') {
  return buildDeepReviewPolicy({
    organizationId: 'org-1',
    repository: { forge: 'github', slug: 'Acme/App' },
    program,
    requestedBy: 'user-1',
    telemetryThresholds: {
      program,
      maxRepositoryFiles: 10_000,
      minIndexedFileRatio: 0.8,
      maxEstimatedModelCalls: program === 'security_review' ? 80 : 40,
      maxEstimatedToolCalls: program === 'security_review' ? 120 : 80,
      maxEstimatedDurationMs: 30 * 60_000,
      maxEstimatedUsd: program === 'security_review' ? 20 : 10,
      acceptedBy: 'admin-1',
      acceptedAt: '2026-07-29T00:00:00.000Z',
    },
    packetLimits: {
      maxPackets: program === 'security_review' ? 60 : 30,
      maxPacketBytes: 16_000,
      maxFilesPerPacket: 12,
    },
    budgets: {
      maxModelCalls: program === 'security_review' ? 60 : 30,
      maxToolCalls: 100,
      maxDurationMs: 20 * 60_000,
      maxUsd: program === 'security_review' ? 15 : 8,
    },
    now: '2026-07-29T01:00:00.000Z',
  });
}

const telemetry = {
  repositoryFiles: 2_000,
  eligibleFiles: 1_000,
  indexedFiles: 900,
  estimatedModelCalls: 30,
  estimatedToolCalls: 70,
  estimatedDurationMs: 10 * 60_000,
  estimatedUsd: 5,
};

test('deep-review policy pins explicit activation, accepted thresholds, budgets, and coverage label', () => {
  const selected = policy();
  assert.equal(selected.activation.mode, 'explicit_manual');
  assert.equal(selected.activation.automaticEscalation, false);
  assert.equal(selected.coverage.label, 'bounded_whole_repository');
  assert.deepEqual(parseDeepReviewPolicy(selected), selected);
  assert.deepEqual(evaluateDeepReviewActivation({
    policy: selected,
    organizationId: 'org-1',
    repository: { forge: 'github', slug: 'acme/app' },
    program: 'security_review',
    source: 'manual_console',
    explicitRequest: true,
    telemetry,
  }), {
    eligible: true,
    coverageLabel: 'bounded_whole_repository',
    reasons: [],
  });
});

test('deep review never auto-escalates from an ordinary diff review', () => {
  const decision = evaluateDeepReviewActivation({
    policy: policy(),
    organizationId: 'org-1',
    repository: { forge: 'github', slug: 'acme/app' },
    program: 'security_review',
    source: 'diff_review',
    explicitRequest: false,
    telemetry,
  });
  assert.equal(decision.eligible, false);
  assert.deepEqual(decision.reasons, [
    'EXPLICIT_OPT_IN_REQUIRED',
    'AUTOMATIC_ESCALATION_FORBIDDEN',
  ]);
});

test('program-specific thresholds cannot be reused across review programs', () => {
  const securityPolicy = policy('security_review');
  assert.throws(
    () => buildDeepReviewPolicy({
      organizationId: 'org-1',
      repository: { forge: 'github', slug: 'acme/app' },
      program: 'code_review',
      requestedBy: 'user-1',
      telemetryThresholds: securityPolicy.telemetryThresholds,
      packetLimits: securityPolicy.packetLimits,
      budgets: securityPolicy.budgets,
    }),
    /must match the review program/,
  );
  assert.deepEqual(evaluateDeepReviewActivation({
    policy: securityPolicy,
    organizationId: 'org-1',
    repository: { forge: 'github', slug: 'acme/app' },
    program: 'code_review',
    source: 'manual_api',
    explicitRequest: true,
    telemetry,
  }).reasons, ['PROGRAM_MISMATCH']);
});

test('telemetry, cost, duration, and index coverage fail closed at policy thresholds', () => {
  const decision = evaluateDeepReviewActivation({
    policy: policy(),
    organizationId: 'org-1',
    repository: { forge: 'github', slug: 'acme/app' },
    program: 'security_review',
    source: 'manual_api',
    explicitRequest: true,
    telemetry: {
      repositoryFiles: 10_001,
      eligibleFiles: 1_000,
      indexedFiles: 700,
      estimatedModelCalls: 61,
      estimatedToolCalls: 101,
      estimatedDurationMs: 20 * 60_000 + 1,
      estimatedUsd: 15.01,
    },
  });
  assert.equal(decision.eligible, false);
  assert.deepEqual(decision.reasons, [
    'REPOSITORY_FILE_THRESHOLD_EXCEEDED',
    'INDEX_COVERAGE_THRESHOLD_NOT_MET',
    'MODEL_CALL_THRESHOLD_EXCEEDED',
    'TOOL_CALL_THRESHOLD_EXCEEDED',
    'DURATION_THRESHOLD_EXCEEDED',
    'COST_THRESHOLD_EXCEEDED',
  ]);
});

test('malformed telemetry cannot bypass deep-review activation limits', () => {
  const selected = policy();
  assert.deepEqual(evaluateDeepReviewActivation({
    policy: selected,
    organizationId: 'org-1',
    repository: { forge: 'github', slug: 'acme/app' },
    program: 'security_review',
    source: 'manual_api',
    explicitRequest: true,
    telemetry: {
      ...telemetry,
      eligibleFiles: 20,
      indexedFiles: 21,
      estimatedUsd: Number.NaN,
    },
  }).reasons, ['TELEMETRY_INVALID']);
});

test('deep-review policy rejects tampering, automatic activation, and unsafe budgets', () => {
  const selected = policy();
  assert.throws(
    () => parseDeepReviewPolicy({
      ...selected,
      activation: { ...selected.activation, automaticEscalation: true },
    }),
    /forbids auto escalation/,
  );
  assert.throws(
    () => parseDeepReviewPolicy({
      ...selected,
      budgets: { ...selected.budgets, maxUsd: 19 },
    }),
    /thresholds|policy hash/,
  );
});
