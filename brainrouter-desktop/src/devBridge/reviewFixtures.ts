import {
  projectReviewAssuranceDetailView,
  type ReviewAssuranceDetailView,
} from '@kinqs/brainrouter-agent-protocol';

const NOW = '2026-07-29T00:00:00.000Z';

const parsedFixture = projectReviewAssuranceDetailView({
  review: {
    id: 'review-dev-1',
    lens: 'security',
    status: 'partial',
    repo: 'kinqsradiollc/BrainRouter',
    prNumber: 42,
    forge: 'github',
    findings: 1,
    blocking: 0,
    skipped: null,
    error: null,
    updatedAt: NOW,
    createdAt: NOW,
  },
  assurance: {
    run: {
      id: 'run-dev-1',
      repository: { forge: 'github', slug: 'kinqsradiollc/BrainRouter' },
      revision: { headSha: 'abc123def456', baseSha: 'base123def456' },
      program: 'security_review',
      policySnapshot: {
        id: 'policy-dev-1',
        policyHash: 'policy-hash-dev',
        organizationId: 'org_demo',
        blockingEnabled: true,
      },
      sourceSnapshot: {
        id: 'source-dev-1',
        status: 'partial',
        fileCount: 14,
        textFileCount: 13,
        indexedFileCount: 12,
        unsupportedFileCount: 1,
      },
      coverage: {
        status: 'partial',
        filesTotal: 14,
        filesEligible: 13,
        filesAnalyzed: 12,
        changedFilesTotal: 4,
        changedFilesAnalyzed: 3,
        analyzers: [{
          analyzerId: 'authorization-rules',
          state: 'partial',
          filesEligible: 13,
          filesAnalyzed: 12,
          diagnosticsProduced: 1,
        }],
        limitations: [{
          id: 'limit-dev-1',
          component: 'index',
          state: 'unsupported',
          reasonCode: 'language_unsupported',
          summary: 'One generated file could not be indexed.',
        }],
        calculatedAt: NOW,
      },
      stages: [{
        id: 'stage-dev-1',
        stage: 'candidate_verification',
        status: 'partial',
        attempt: 1,
      }],
      status: 'partial',
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
    },
    findings: [{
      id: 'finding-dev-1',
      fingerprint: 'fingerprint-dev-1',
      program: 'security_review',
      revisionSha: 'abc123def456',
      state: 'insufficient_evidence',
      severity: 'high',
      confidence: 0.78,
      title: 'Organization boundary requires verification',
      mechanism: 'The indexed call path does not prove an organization constraint.',
      location: { path: 'src/access.ts', line: 18, symbol: 'updateRecord' },
      evidence: [{
        id: 'evidence-dev-1',
        kind: 'call_path',
        summary: 'The available call path ends before the organization predicate is applied.',
        revisionSha: 'abc123def456',
        createdAt: NOW,
      }],
      provenance: [],
      coverageLimitations: [],
      verifier: {
        state: 'insufficient_evidence',
        verifierId: 'independent-verifier',
        rationale: 'A required caller was outside the available index.',
        evidenceRefs: ['evidence-dev-1'],
        decidedAt: NOW,
      },
      createdAt: NOW,
      updatedAt: NOW,
    }],
  },
  canRun: true,
});

if (!parsedFixture) throw new Error('Invalid development review assurance fixture.');
const fixture: ReviewAssuranceDetailView = parsedFixture;

export function devReviewAssuranceDetail(jobId: unknown): ReviewAssuranceDetailView {
  if (jobId !== fixture.review.id) throw new Error('Review job not found.');
  return fixture;
}
