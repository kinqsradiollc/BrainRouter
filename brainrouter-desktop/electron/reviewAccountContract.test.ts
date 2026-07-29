import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchAccountReviewAssurance,
  reviewAssuranceDetailPath,
} from './reviewAccountContract.js';

const NOW = '2026-07-29T00:00:00.000Z';

function detail() {
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
        repository: { forge: 'github', slug: 'owner/repository' },
        revision: { headSha: 'head-sha' },
        program: 'security_review',
        policySnapshot: {
          id: 'policy-one',
          policyHash: 'policy-hash',
          organizationId: 'org-one',
          blockingEnabled: true,
        },
        sourceSnapshot: {
          id: 'source-one',
          status: 'partial',
          fileCount: 3,
          textFileCount: 3,
          indexedFileCount: 2,
          unsupportedFileCount: 0,
        },
        coverage: {
          status: 'partial',
          filesTotal: 3,
          filesEligible: 3,
          filesAnalyzed: 2,
          changedFilesTotal: 2,
          changedFilesAnalyzed: 1,
          analyzers: [],
          limitations: [{
            id: 'limit-one',
            component: 'index',
            state: 'failed',
            reasonCode: 'parser_unavailable',
            summary: 'One changed file could not be indexed.',
          }],
          calculatedAt: NOW,
        },
        stages: [{
          id: 'stage-one',
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
        id: 'finding-one',
        fingerprint: 'fingerprint-one',
        program: 'security_review',
        revisionSha: 'head-sha',
        state: 'insufficient_evidence',
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
          state: 'insufficient_evidence',
          verifierId: 'independent-verifier',
          rationale: 'A required caller was outside the available index.',
          evidenceRefs: ['evidence-one'],
          decidedAt: NOW,
        },
        createdAt: NOW,
        updatedAt: NOW,
      }],
    },
    canRun: false,
  };
}

test('review detail path accepts bounded opaque ids and rejects path injection', () => {
  assert.equal(reviewAssuranceDetailPath('job-one:2'), '/api/admin/reviews/jobs/job-one%3A2');
  assert.throws(() => reviewAssuranceDetailPath('../job'), /Invalid review job id/);
  assert.throws(() => reviewAssuranceDetailPath('job/one'), /Invalid review job id/);
});

test('desktop account query keeps credentials privileged and returns protocol detail unchanged', async () => {
  let request: { url: string; authorization?: string; org?: string } | undefined;
  const projected = await fetchAccountReviewAssurance(
    { baseUrl: 'https://brain.example', apiKey: 'secret', orgId: 'org-one' },
    'job-one',
    async (url, init) => {
      request = {
        url,
        authorization: init?.headers?.Authorization,
        org: init?.headers?.['X-BrainRouter-Org'],
      };
      return {
        ok: true,
        status: 200,
        async json() { return detail(); },
      };
    },
  );
  assert.deepEqual(request, {
    url: 'https://brain.example/api/admin/reviews/jobs/job-one',
    authorization: 'Bearer secret',
    org: 'org-one',
  });
  assert.equal(projected.assurance?.run.status, 'partial');
  assert.equal(projected.assurance?.run.coverage.status, 'partial');
  assert.equal(projected.assurance?.run.stages[0].status, 'partial');
  assert.equal(projected.assurance?.findings[0].state, 'insufficient_evidence');
  assert.equal(projected.assurance?.findings[0].verifier?.state, 'insufficient_evidence');
});

test('desktop account query rejects malformed assurance payloads', async () => {
  await assert.rejects(
    fetchAccountReviewAssurance(
      { baseUrl: 'https://brain.example', apiKey: 'secret', orgId: 'org-one' },
      'job-one',
      async () => ({
        ok: true,
        status: 200,
        async json() { return { review: {}, assurance: null, canRun: true }; },
      }),
    ),
    /invalid assurance detail/,
  );
});
