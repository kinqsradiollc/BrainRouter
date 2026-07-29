/**
 * Durable assurance projection fixtures.
 *
 * Every explicit run/source/coverage/stage state must survive the dependency-
 * free wire guard; malformed counters and missing lifecycle evidence must not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSURANCE_COMPONENT_STATUS_VIEWS,
  ASSURANCE_COVERAGE_STATUS_VIEWS,
  ASSURANCE_PROGRAM_VIEWS,
  ASSURANCE_RUN_STATUS_VIEWS,
  ASSURANCE_SOURCE_STATUS_VIEWS,
  ASSURANCE_STAGE_STATUS_VIEWS,
  isAgentEventMessage,
  isAssuranceRunEventView,
  type AssuranceRunEventView,
} from './index.js';

function runView(): AssuranceRunEventView {
  return {
    id: 'run-1',
    organizationId: 'org-1',
    repository: { forge: 'github', slug: 'owner/repository', repositoryId: 'repo-1' },
    revision: { baseSha: 'base', headSha: 'head', mergeBaseSha: 'merge' },
    program: 'security_review',
    policy: { id: 'policy-1', hash: 'policy-hash', blockingEnabled: true },
    source: {
      id: 'source-1',
      status: 'partial',
      fileCount: 10,
      textFileCount: 9,
      indexedFileCount: 7,
      unsupportedFileCount: 1,
      checkoutRef: 'checkout:head',
      inventoryRef: 'inventory:head',
    },
    coverage: {
      status: 'partial',
      filesTotal: 10,
      filesEligible: 9,
      filesAnalyzed: 7,
      changedFilesTotal: 3,
      changedFilesAnalyzed: 2,
      analyzers: [{
        id: 'analyzer-1',
        state: 'partial',
        filesEligible: 9,
        filesAnalyzed: 7,
        diagnosticsProduced: 1,
      }],
      limitations: [{
        id: 'limitation-1',
        component: 'analyzer-1',
        state: 'partial',
        reasonCode: 'UNSUPPORTED_LANGUAGE',
        summary: 'One language is not indexed.',
      }],
      calculatedAt: '2026-07-29T00:00:00.000Z',
    },
    stages: [{
      id: 'stage-1',
      name: 'deterministic_analysis',
      status: 'partial',
      attempt: 1,
      errorCode: 'UNSUPPORTED_LANGUAGE',
    }],
    status: 'partial',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:01:00.000Z',
    completedAt: '2026-07-29T00:01:00.000Z',
  };
}

test('assurance projection guard accepts every explicit state vocabulary', () => {
  const base = runView();
  for (const program of ASSURANCE_PROGRAM_VIEWS) {
    assert.equal(isAssuranceRunEventView({ ...base, program }), true);
  }
  for (const status of ASSURANCE_RUN_STATUS_VIEWS) {
    assert.equal(isAssuranceRunEventView({
      ...base,
      status,
      ...(status === 'superseded' ? { supersededByRunId: 'run-2' } : {}),
      ...(status === 'stale' ? { staleReason: 'head changed' } : {}),
    }), true, `run status ${status}`);
  }
  for (const status of ASSURANCE_SOURCE_STATUS_VIEWS) {
    assert.equal(isAssuranceRunEventView({
      ...base,
      source: { ...base.source, status },
    }), true, `source status ${status}`);
  }
  for (const status of ASSURANCE_COVERAGE_STATUS_VIEWS) {
    assert.equal(isAssuranceRunEventView({
      ...base,
      coverage: { ...base.coverage, status },
    }), true, `coverage status ${status}`);
  }
  for (const status of ASSURANCE_COMPONENT_STATUS_VIEWS) {
    assert.equal(isAssuranceRunEventView({
      ...base,
      coverage: {
        ...base.coverage,
        analyzers: [{ ...base.coverage.analyzers[0], state: status }],
      },
    }), true, `analyzer status ${status}`);
  }
  for (const status of ASSURANCE_STAGE_STATUS_VIEWS) {
    assert.equal(isAssuranceRunEventView({
      ...base,
      stages: [{ ...base.stages[0], status }],
    }), true, `stage status ${status}`);
  }
});

test('assurance projection guard rejects malformed or unevidenced terminal views', () => {
  const base = runView();
  assert.equal(isAssuranceRunEventView({
    ...base,
    coverage: { ...base.coverage, filesAnalyzed: 10 },
  }), false);
  assert.equal(isAssuranceRunEventView({
    ...base,
    coverage: {
      ...base.coverage,
      limitations: [{ ...base.coverage.limitations[0], state: 'covered' }],
    },
  }), false);
  assert.equal(isAssuranceRunEventView({ ...base, status: 'superseded' }), false);
  assert.equal(isAssuranceRunEventView({ ...base, status: 'stale' }), false);
  assert.equal(isAssuranceRunEventView({
    ...base,
    stages: [{ ...base.stages[0], attempt: 0 }],
  }), false);
});

test('assurance run events use the normal monotonic agent envelope', () => {
  const message = {
    seq: 1,
    ts: 2,
    sessionKey: 'session-1',
    event: {
      kind: 'assurance-run',
      action: 'receipt-updated',
      run: runView(),
    },
  };
  assert.equal(isAgentEventMessage(message), true);
  assert.equal(isAssuranceRunEventView(message.event.run), true);
});
