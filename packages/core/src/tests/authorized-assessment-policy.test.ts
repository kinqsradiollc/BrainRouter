import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAuthorizedAssessmentTarget,
  buildAuthorizedAssessmentPolicy,
  parseAuthorizedAssessmentPolicy,
} from '../review/domain/authorizedAssessmentPolicy.js';
import type { PentestTargetRecord } from '@kinqs/brainrouter-types';

const target: PentestTargetRecord = {
  id: 'target-1',
  orgId: 'org-1',
  createdBy: 'user-1',
  kind: 'domain',
  value: 'https://Example.test/path',
  normalizedValue: 'https://example.test',
  label: null,
  authorizedAt: '2026-07-29T00:00:00.000Z',
  createdAt: '2026-07-29T00:00:00.000Z',
  updatedAt: '2026-07-29T00:00:00.000Z',
};

test('authorized assessment policy binds authority, perimeter, budgets, cancellation, and evidence', () => {
  const policy = buildAuthorizedAssessmentPolicy(target, {
    scanMode: 'standard',
    now: '2026-07-29T01:00:00.000Z',
  });

  assert.equal(policy.program, 'authorized_pentest');
  assert.deepEqual(policy.perimeter, {
    liveNetwork: true,
    allowedOrigins: ['https://example.test'],
    allowedRepositories: [],
  });
  assert.equal(policy.budget.maxUsd, 5);
  assert.equal(policy.budget.maxTokens, 1_000_000);
  assert.equal(policy.cancellation.mode, 'cooperative_fail_closed');
  assert.deepEqual(policy.evidence, {
    retentionDays: 30,
    redactSecrets: true,
    rawRequestRetention: 'none',
  });
  assert.deepEqual(parseAuthorizedAssessmentPolicy(policy), policy);
  assert.doesNotThrow(() => assertAuthorizedAssessmentTarget(policy, target));
});

test('authorized assessment policy rejects tampering and changed target authority', () => {
  const policy = buildAuthorizedAssessmentPolicy(target, {
    scanMode: 'standard',
    now: '2026-07-29T01:00:00.000Z',
  });

  assert.throws(
    () => parseAuthorizedAssessmentPolicy({
      ...policy,
      budget: { ...policy.budget, maxUsd: 500 },
    }),
    /policy hash/,
  );
  assert.throws(
    () => assertAuthorizedAssessmentTarget(policy, {
      ...target,
      authorizedAt: '2026-07-30T00:00:00.000Z',
    }),
    /missing, revoked, or changed/,
  );
  assert.throws(
    () => assertAuthorizedAssessmentTarget(policy, {
      ...target,
      orgId: 'org-2',
    }),
    /missing, revoked, or changed/,
  );
  assert.throws(
    () => assertAuthorizedAssessmentTarget(policy, null),
    /missing, revoked, or changed/,
  );
});

test('repository assessment policy cannot acquire a live-network perimeter', () => {
  const repositoryTarget: PentestTargetRecord = {
    ...target,
    id: 'target-2',
    kind: 'repository',
    value: 'Acme/App',
    normalizedValue: 'acme/app',
  };
  const policy = buildAuthorizedAssessmentPolicy(repositoryTarget, {
    scanMode: 'code-review',
    now: '2026-07-29T01:00:00.000Z',
  });

  assert.equal(policy.perimeter.liveNetwork, false);
  assert.deepEqual(policy.perimeter.allowedRepositories, ['acme/app']);
  assert.throws(
    () => parseAuthorizedAssessmentPolicy({
      ...policy,
      perimeter: { ...policy.perimeter, liveNetwork: true },
    }),
    /perimeter|policy hash/,
  );
  assert.throws(
    () => buildAuthorizedAssessmentPolicy(target, {
      scanMode: 'code-review',
      now: '2026-07-29T01:00:00.000Z',
    }),
    /cannot use source-only/,
  );
});
