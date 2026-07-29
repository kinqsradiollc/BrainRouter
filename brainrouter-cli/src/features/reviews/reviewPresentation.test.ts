import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AssuranceFindingStateView,
  AssuranceRunStatusView,
  ReviewAssuranceDetailView,
} from '@kinqs/brainrouter-core/review';
import {
  renderReviewAssuranceDetail,
  renderReviewList,
} from './reviewPresentation.js';

const NOW = '2026-07-29T00:00:00.000Z';

function detail(
  status: AssuranceRunStatusView = 'completed',
  findingState: AssuranceFindingStateView = 'verified',
): ReviewAssuranceDetailView {
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
      skipped: null,
      error: null,
      updatedAt: NOW,
      createdAt: NOW,
    },
    assurance: {
      run: {
        id: 'run-one',
        organizationId: 'org-one',
        repository: { forge: 'github', slug: 'owner/repository' },
        revision: { headSha: 'head-sha', baseSha: 'base-sha' },
        program: 'security_review',
        policy: { id: 'policy-one', hash: 'policy-hash', blockingEnabled: true },
        source: {
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
          analyzers: [],
          limitations: status === 'partial' ? [{
            id: 'limit-one',
            component: 'index',
            state: 'failed',
            reasonCode: 'parser_unavailable',
            summary: 'One changed file could not be indexed.',
          }] : [],
          calculatedAt: NOW,
        },
        stages: [{
          id: 'stage-one',
          name: 'candidate_verification',
          status: status === 'partial' ? 'partial' : 'succeeded',
          attempt: 1,
        }],
        status,
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: NOW,
        ...(status === 'stale' ? { staleReason: 'The pull request head changed.' } : {}),
        ...(status === 'superseded' ? { supersededByRunId: 'run-two' } : {}),
      },
      findings: [{
        id: 'finding-one',
        fingerprint: 'fingerprint-one',
        program: 'security_review',
        revisionSha: 'head-sha',
        state: findingState,
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
          createdAt: NOW,
        }],
        provenance: [],
        coverageLimitations: [],
        verifier: {
          state: findingState === 'candidate' || findingState === 'hotspot'
            ? 'insufficient_evidence'
            : findingState,
          verifierId: 'independent-verifier',
          rationale: findingState === 'insufficient_evidence'
            ? 'A required caller was outside the available index.'
            : 'The exact source path confirms the candidate.',
          evidenceRefs: ['evidence-one'],
          decidedAt: NOW,
        },
        createdAt: NOW,
        updatedAt: NOW,
      }],
    },
    canRun: true,
  };
}

test('CLI review list retains job identifiers and read/run authority', () => {
  const value = detail();
  assert.match(renderReviewList([value.review], false), /review-one  security  done/);
  assert.match(renderReviewList([value.review], false), /read only/);
});

test('CLI complete fixture renders exact run, revision, coverage, stage, finding, evidence, and disposition values', () => {
  const output = renderReviewAssuranceDetail(detail());
  assert.match(output, /Assurance run-one · security_review · completed/);
  assert.match(output, /Revision head-sha · base base-sha/);
  assert.match(output, /Coverage complete · 3\/3 eligible files · changed 2\/2/);
  assert.match(output, /candidate_verification · succeeded · attempt 1/);
  assert.match(output, /HIGH · verified · Authorization boundary/);
  assert.match(output, /Evidence \[source\] evidence-one/);
  assert.match(output, /Verifier independent-verifier: verified/);
});

test('CLI partial and unresolved fixtures retain limitations without a clean-state upgrade', () => {
  const output = renderReviewAssuranceDetail(detail('partial', 'insufficient_evidence'));
  assert.match(output, /Assurance run-one · security_review · partial/);
  assert.match(output, /Coverage partial · 2\/3 eligible files · changed 1\/2/);
  assert.match(output, /Coverage limitation \[failed\] index/);
  assert.match(output, /candidate_verification · partial/);
  assert.match(output, /HIGH · insufficient_evidence/);
  assert.match(output, /Verifier independent-verifier: insufficient_evidence/);
});

test('CLI stale and superseded fixtures explain expired authority', () => {
  assert.match(
    renderReviewAssuranceDetail(detail('stale')),
    /Stale: The pull request head changed\./,
  );
  assert.match(
    renderReviewAssuranceDetail(detail('superseded')),
    /Superseded by run-two/,
  );
});

test('CLI missing assurance is explicit rather than presented as clean', () => {
  const value = detail();
  value.assurance = null;
  assert.match(renderReviewAssuranceDetail(value), /Durable assurance: not recorded/);
});
