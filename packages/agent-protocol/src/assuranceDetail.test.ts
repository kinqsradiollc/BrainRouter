import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectReviewAssuranceDetailView,
  type AssuranceFindingStateView,
} from './index.js';

const NOW = '2026-07-29T00:00:00.000Z';

function finding(state: AssuranceFindingStateView = 'verified') {
  return {
    id: 'finding-one',
    fingerprint: 'fingerprint-one',
    program: 'security_review',
    revisionSha: 'head-sha',
    state,
    severity: 'high',
    confidence: 0.82,
    title: 'Authorization boundary',
    mechanism: 'A sensitive write lacks an ownership constraint.',
    location: { path: 'src/access.ts', line: 18 },
    evidence: [{
      id: 'evidence-one',
      kind: 'source',
      summary: 'The write query omits the organization identifier.',
      revisionSha: 'head-sha',
      location: { path: 'src/access.ts', line: 18 },
      analyzerId: 'authorization-rules',
      createdAt: NOW,
    }],
    provenance: [{
      producerKind: 'deterministic_analyzer',
      producerId: 'authorization-rules',
      version: '1.0.0',
      policyHash: 'policy-hash',
      createdAt: NOW,
    }],
    coverageLimitations: [],
    verifier: {
      state: state === 'candidate' || state === 'hotspot' ? 'insufficient_evidence' : state,
      verifierId: 'independent-verifier',
      rationale: state === 'insufficient_evidence'
        ? 'A required caller was outside the available index.'
        : 'The exact source path confirms the candidate.',
      evidenceRefs: ['evidence-one'],
      decidedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function detail(status = 'completed', selectedFinding = finding()) {
  return {
    review: {
      id: 'review-one',
      lens: 'security',
      status: 'done',
      repo: 'owner/repository',
      prNumber: 42,
      forge: 'github',
      findings: 1,
      blocking: 1,
      findingsDetail: [],
      progress: [],
      skipped: null,
      error: null,
      updatedAt: NOW,
      createdAt: NOW,
    },
    assurance: {
      run: {
        id: 'run-one',
        repository: { forge: 'github', slug: 'owner/repository' },
        revision: { headSha: 'head-sha', baseSha: 'base-sha' },
        program: 'security_review',
        policySnapshot: {
          id: 'policy-one',
          policyHash: 'policy-hash',
          organizationId: 'org-one',
          blockingEnabled: true,
        },
        sourceSnapshot: {
          id: 'source-one',
          status: status === 'partial' ? 'partial' : 'ready',
          fileCount: 3,
          textFileCount: 3,
          indexedFileCount: status === 'partial' ? 2 : 3,
          unsupportedFileCount: 0,
        },
        coverage: {
          status: status === 'partial' ? 'partial' : 'complete',
          filesTotal: 3,
          filesEligible: 3,
          filesAnalyzed: status === 'partial' ? 2 : 3,
          changedFilesTotal: 2,
          changedFilesAnalyzed: status === 'partial' ? 1 : 2,
          analyzers: [{
            analyzerId: 'authorization-rules',
            state: status === 'partial' ? 'partial' : 'covered',
            filesEligible: 3,
            filesAnalyzed: status === 'partial' ? 2 : 3,
            diagnosticsProduced: 1,
          }],
          limitations: status === 'partial' ? [{
            id: 'limit-one',
            component: 'index',
            state: 'failed',
            reasonCode: 'parser_unavailable',
            summary: 'One changed file could not be indexed.',
            affectedPaths: ['src/generated.ts'],
          }] : [],
          calculatedAt: NOW,
        },
        stages: [{
          id: 'stage-one',
          stage: 'candidate_verification',
          status: status === 'partial' ? 'partial' : 'succeeded',
          attempt: 1,
          errorCode: status === 'partial' ? 'parser_unavailable' : undefined,
        }],
        status,
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: NOW,
        ...(status === 'stale' ? { staleReason: 'The pull request head changed.' } : {}),
        ...(status === 'superseded' ? { supersededByRunId: 'run-two' } : {}),
      },
      findings: [selectedFinding],
    },
    canRun: true,
  };
}

test('review assurance detail projects the same durable run, coverage, stage, finding, and disposition values', () => {
  const projected = projectReviewAssuranceDetailView(detail());
  assert.ok(projected?.assurance);
  assert.equal(projected.assurance.run.id, 'run-one');
  assert.equal(projected.assurance.run.revision.headSha, 'head-sha');
  assert.equal(projected.assurance.run.coverage.status, 'complete');
  assert.equal(projected.assurance.run.coverage.analyzers[0].id, 'authorization-rules');
  assert.equal(projected.assurance.run.stages[0].status, 'succeeded');
  assert.equal(projected.assurance.findings[0].state, 'verified');
  assert.equal(projected.assurance.findings[0].evidence[0].summary, 'The write query omits the organization identifier.');
  assert.equal(projected.assurance.findings[0].verifier?.state, 'verified');
});

test('partial, stale, superseded, and unresolved states are never upgraded', () => {
  const partial = projectReviewAssuranceDetailView(detail('partial', finding('insufficient_evidence')));
  assert.equal(partial?.assurance?.run.status, 'partial');
  assert.equal(partial?.assurance?.run.coverage.status, 'partial');
  assert.equal(partial?.assurance?.run.stages[0].status, 'partial');
  assert.equal(partial?.assurance?.findings[0].state, 'insufficient_evidence');
  assert.equal(partial?.assurance?.findings[0].verifier?.state, 'insufficient_evidence');

  assert.equal(projectReviewAssuranceDetailView(detail('stale'))?.assurance?.run.staleReason, 'The pull request head changed.');
  assert.equal(projectReviewAssuranceDetailView(detail('superseded'))?.assurance?.run.supersededByRunId, 'run-two');
});

test('missing assurance is an explicit valid state', () => {
  const value = detail();
  value.assurance = null as never;
  assert.deepEqual(projectReviewAssuranceDetailView(value), {
    review: {
      id: 'review-one',
      lens: 'security',
      status: 'done',
      repo: 'owner/repository',
      prNumber: 42,
      forge: 'github',
      findings: 1,
      blocking: 1,
      skipped: null,
      error: null,
      updatedAt: NOW,
      createdAt: NOW,
    },
    assurance: null,
    canRun: true,
  });
});

test('malformed authority data is rejected instead of normalized upward', () => {
  const invalidCounter = detail();
  invalidCounter.assurance.run.coverage.filesAnalyzed = 4;
  assert.equal(projectReviewAssuranceDetailView(invalidCounter), null);

  const invalidVerifier = detail();
  (invalidVerifier.assurance.findings[0].verifier as { state: string }).state = 'candidate';
  assert.equal(projectReviewAssuranceDetailView(invalidVerifier), null);

  const invalidTerminal = detail('stale');
  delete invalidTerminal.assurance.run.staleReason;
  assert.equal(projectReviewAssuranceDetailView(invalidTerminal), null);
});
