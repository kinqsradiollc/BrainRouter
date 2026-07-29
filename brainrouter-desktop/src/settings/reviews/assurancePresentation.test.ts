import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AssuranceFindingStateView,
  AssurancePublicationStatusView,
  AssuranceRunStatusView,
  ReviewAssuranceDetailView,
} from '@kinqs/brainrouter-agent-protocol';
import { buildDesktopAssurancePresentation } from './assurancePresentation.js';

const NOW = '2026-07-29T00:00:00.000Z';

function publicationStatus(status: AssuranceRunStatusView): AssurancePublicationStatusView {
  if (status === 'queued') return 'running';
  if (status === 'completed') return 'blocked';
  return status;
}

function fixture(
  status: AssuranceRunStatusView = 'completed',
  findingState: AssuranceFindingStateView = 'verified',
): ReviewAssuranceDetailView {
  return {
    review: {
      id: 'review-one', lens: 'security', status: 'done',
      repo: 'owner/repository', prNumber: 42, forge: 'github',
      findings: 1, blocking: 1, skipped: null, error: null,
      updatedAt: NOW, createdAt: NOW,
    },
    assurance: {
      publication: {
        schemaVersion: 1,
        status: publicationStatus(status),
        label: publicationStatus(status),
        conclusion: 'failure',
        blocked: true,
        cleanEligible: false,
        reason: status === 'partial'
          ? 'Coverage is incomplete.'
          : 'Publication policy does not permit a clean conclusion.',
        blockingFindingIds: status === 'completed' ? ['finding-one'] : [],
      },
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
          fileCount: 3, textFileCount: 3,
          indexedFileCount: status === 'partial' ? 2 : 3,
          unsupportedFileCount: 0,
        },
        coverage: {
          status: status === 'partial' ? 'partial' : 'complete',
          filesTotal: 3, filesEligible: 3,
          filesAnalyzed: status === 'partial' ? 2 : 3,
          changedFilesTotal: 2,
          changedFilesAnalyzed: status === 'partial' ? 1 : 2,
          analyzers: [],
          limitations: status === 'partial' ? [{
            id: 'limit-one', component: 'index', state: 'failed',
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
          id: 'evidence-one', kind: 'source',
          summary: 'The write query omits the organization identifier.',
          revisionSha: 'head-sha', createdAt: NOW,
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

test('Desktop complete fixture presents exact protocol values', () => {
  const view = buildDesktopAssurancePresentation(fixture());
  assert.equal(view.runId, 'run-one');
  assert.equal(view.runStatus, 'completed');
  assert.equal(view.status, 'blocked');
  assert.equal(view.publication?.conclusion, 'failure');
  assert.equal(view.revision, 'head-sha');
  assert.equal(view.coverage?.status, 'complete');
  assert.equal(view.coverage?.files, '3/3 eligible files');
  assert.equal(view.stages[0].status, 'succeeded');
  assert.equal(view.findings[0].state, 'verified');
  assert.equal(view.findings[0].evidence[0].summary, 'The write query omits the organization identifier.');
  assert.equal(view.findings[0].verifier?.state, 'verified');
});

test('Desktop partial and unresolved fixtures never render as complete or verified', () => {
  const view = buildDesktopAssurancePresentation(fixture('partial', 'insufficient_evidence'));
  assert.equal(view.status, 'partial');
  assert.equal(view.runStatus, 'partial');
  assert.equal(view.publication?.reason, 'Coverage is incomplete.');
  assert.equal(view.coverage?.status, 'partial');
  assert.equal(view.coverage?.limitations[0].state, 'failed');
  assert.equal(view.stages[0].status, 'partial');
  assert.equal(view.findings[0].state, 'insufficient_evidence');
  assert.equal(view.findings[0].verifier?.state, 'insufficient_evidence');
});

test('Desktop stale and superseded fixtures preserve authority-expiry receipts', () => {
  assert.equal(
    buildDesktopAssurancePresentation(fixture('stale')).staleReason,
    'The pull request head changed.',
  );
  assert.equal(
    buildDesktopAssurancePresentation(fixture('superseded')).supersededBy,
    'run-two',
  );
});

test('Desktop missing assurance is explicit', () => {
  const value = fixture();
  value.assurance = null;
  assert.deepEqual(buildDesktopAssurancePresentation(value), {
    available: false,
    stages: [],
    findings: [],
  });
});
