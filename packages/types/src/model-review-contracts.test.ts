import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOSTED_MODEL_POLICY_FIXTURES,
  MODEL_REASONING_EFFORTS,
  type CustomModelCapabilityProfile,
  type ModelCatalogEnvelope,
  type ModelReasoningEffort,
} from './models.js';
import {
  REPOSITORY_REVIEW_STATE_KEYS,
  type RepositoryReviewAvailability,
} from './reviews.js';

const OPENAI_56_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const FABLE_5_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

test('canonical effort vocabulary excludes orchestration-only ultracode', () => {
  assert.deepEqual(MODEL_REASONING_EFFORTS, [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  assert.equal((MODEL_REASONING_EFFORTS as readonly string[]).includes('ultracode'), false);

  // @ts-expect-error ultracode is a workflow mode, never an API reasoning effort.
  const invalidEffort: ModelReasoningEffort = 'ultracode';
  void invalidEffort;
});

test('hosted model fixtures preserve the verified model-specific effort sets', () => {
  const byId = new Map(HOSTED_MODEL_POLICY_FIXTURES.map((model) => [model.id, model]));

  for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    const policy = byId.get(id);
    assert.ok(policy, `missing hosted fixture for ${id}`);
    assert.deepEqual(
      policy.reasoning?.allowed.map((effort) => effort.id),
      OPENAI_56_EFFORTS,
    );
    assert.equal(policy.reasoning?.default, null);
    assert.equal(policy.reasoning?.mode, 'selectable');
  }

  const fable = byId.get('claude-fable-5');
  assert.ok(fable, 'missing hosted fixture for claude-fable-5');
  assert.deepEqual(
    fable.reasoning?.allowed.map((effort) => effort.id),
    FABLE_5_EFFORTS,
  );
  assert.equal(fable.reasoning?.default, 'high');
  assert.equal(fable.reasoning?.mode, 'adaptive');
  assert.equal(fable.reasoning?.manualBudgetTokens, 'unsupported');
  assert.equal(fable.provenance.source, 'verified');

  const catalog: ModelCatalogEnvelope = {
    revision: 'seed:2026-07-14',
    models: HOSTED_MODEL_POLICY_FIXTURES,
  };
  assert.equal(catalog.models.length, 4);
});

test('custom models represent unknown or inferred capabilities without changing hosted policy', () => {
  const unknown: CustomModelCapabilityProfile = { status: 'unknown' };
  const inferred: CustomModelCapabilityProfile = {
    status: 'inferred',
    provenance: { source: 'inferred' },
    capabilities: { streaming: true, tools: false },
    reasoning: { allowed: ['low', 'high'], default: 'high' },
  };

  assert.equal(unknown.status, 'unknown');
  assert.equal(inferred.provenance.source, 'inferred');
  assert.deepEqual(inferred.reasoning?.allowed, ['low', 'high']);
  assert.deepEqual(
    HOSTED_MODEL_POLICY_FIXTURES.find((model) => model.id === 'claude-fable-5')
      ?.reasoning?.allowed.map((effort) => effort.id),
    FABLE_5_EFFORTS,
  );
});

test('review availability keeps account, repository, and automation state independent', () => {
  assert.deepEqual(REPOSITORY_REVIEW_STATE_KEYS, [
    'accountConnected',
    'repositoryAccessible',
    'autoReviewEnabled',
  ]);

  const accountWithoutRepository: RepositoryReviewAvailability = {
    accountConnected: true,
    repositoryAccessible: false,
    autoReviewEnabled: false,
  };
  const appAccessibleForManualReview: RepositoryReviewAvailability = {
    accountConnected: false,
    repositoryAccessible: true,
    autoReviewEnabled: false,
  };
  const automatedRepository: RepositoryReviewAvailability = {
    accountConnected: false,
    repositoryAccessible: true,
    autoReviewEnabled: true,
  };

  assert.equal(accountWithoutRepository.repositoryAccessible, false);
  assert.equal(appAccessibleForManualReview.autoReviewEnabled, false);
  assert.equal(automatedRepository.autoReviewEnabled, true);
});
