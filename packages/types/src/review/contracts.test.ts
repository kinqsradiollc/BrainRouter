import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPOSITORY_ASSURANCE_PROGRAMS,
  type AssuranceFinding,
  type RepositoryAssuranceRun,
} from './index.js';
import {
  REPOSITORY_ASSURANCE_PROGRAMS as REVIEW_COMPAT_PROGRAMS,
} from '../reviews.js';
import {
  REPOSITORY_ASSURANCE_PROGRAMS as ROOT_COMPAT_PROGRAMS,
} from '../index.js';

function completeRun(): RepositoryAssuranceRun {
  return {
    id: 'run-1',
    repository: { forge: 'github', slug: 'owner/repository', repositoryId: '42' },
    revision: { baseSha: 'base', headSha: 'head' },
    program: 'security_review',
    policySnapshot: {
      id: 'policy-1',
      policyHash: 'sha256:policy',
      organizationId: 'org-1',
      program: 'security_review',
      analyzers: [{ id: 'typescript', enabled: true, required: true }],
      packetLimits: { maxPackets: 8, maxPacketBytes: 64_000, maxFilesPerPacket: 24 },
      budgets: { maxModelCalls: 12, maxToolCalls: 40, maxDurationMs: 600_000 },
      redactionPolicyId: 'redact-1',
      publicationPolicyId: 'publish-1',
      inlineFindingsEnabled: false,
      blockingEnabled: true,
      createdAt: '2026-07-29T00:00:00.000Z',
    },
    sourceSnapshot: {
      id: 'source-1',
      revision: { baseSha: 'base', headSha: 'head' },
      status: 'ready',
      checkoutRef: 'checkout-1',
      inventoryRef: 'inventory-1',
      fileCount: 10,
      textFileCount: 10,
      indexedFileCount: 10,
      unsupportedFileCount: 0,
      createdAt: '2026-07-29T00:00:01.000Z',
      completedAt: '2026-07-29T00:00:02.000Z',
    },
    coverage: {
      status: 'complete',
      filesTotal: 10,
      filesEligible: 10,
      filesAnalyzed: 10,
      changedFilesTotal: 2,
      changedFilesAnalyzed: 2,
      analyzers: [{
        analyzerId: 'typescript',
        state: 'covered',
        supportedLanguages: ['typescript'],
        filesEligible: 10,
        filesAnalyzed: 10,
        diagnosticsProduced: 0,
        limitationIds: [],
      }],
      limitations: [],
      calculatedAt: '2026-07-29T00:00:03.000Z',
    },
    stages: [{
      id: 'stage-1',
      stage: 'authorize',
      status: 'succeeded',
      attempt: 1,
      inputRefs: [],
      outputRefs: ['authorization-1'],
      limitationIds: [],
      startedAt: '2026-07-29T00:00:00.000Z',
      completedAt: '2026-07-29T00:00:01.000Z',
    }],
    findings: [],
    status: 'completed',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:03.000Z',
    completedAt: '2026-07-29T00:00:03.000Z',
  };
}

test('repository-assurance contracts round-trip without losing pinned policy or coverage', () => {
  const original = completeRun();
  const decoded = JSON.parse(JSON.stringify(original)) as RepositoryAssuranceRun;
  assert.deepEqual(decoded, original);
  assert.equal(decoded.revision.headSha, decoded.sourceSnapshot.revision.headSha);
  assert.equal(decoded.program, decoded.policySnapshot.program);
  assert.equal(decoded.coverage.status, 'complete');
});

test('partial and limited coverage round-trips as explicit non-clean evidence', () => {
  const run = completeRun();
  run.coverage.status = 'partial';
  run.coverage.limitations.push({
    id: 'limit-1',
    component: 'typescript',
    state: 'failed',
    reasonCode: 'analyzer_failed',
    summary: 'Analyzer exited before producing diagnostics.',
  });
  const decoded = JSON.parse(JSON.stringify(run)) as RepositoryAssuranceRun;
  assert.equal(decoded.coverage.status, 'partial');
  assert.equal(decoded.coverage.limitations[0]?.state, 'failed');
});

test('candidate and independently verified finding states remain distinct', () => {
  const finding: AssuranceFinding = {
    id: 'finding-1',
    fingerprint: 'fp-1',
    program: 'security_review',
    revisionSha: 'head',
    state: 'candidate',
    severity: 'high',
    confidence: 0.9,
    title: 'Candidate issue',
    mechanism: 'Untrusted data may reach a sensitive operation.',
    location: { path: 'src/example.ts', line: 10 },
    evidence: [],
    provenance: [],
    coverageLimitations: [],
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  };
  assert.equal(finding.state, 'candidate');
  assert.equal(finding.verifier, undefined);

  finding.state = 'verified';
  finding.evidence.push({
    id: 'evidence-1',
    kind: 'call_path',
    summary: 'Parser-backed path reaches the sensitive operation.',
    revisionSha: 'head',
    createdAt: '2026-07-29T00:00:01.000Z',
  });
  finding.provenance.push({
    producerKind: 'deterministic_analyzer',
    producerId: 'analyzer-1',
    policyHash: 'sha256:policy',
    createdAt: '2026-07-29T00:00:01.000Z',
  });
  finding.verifier = {
    state: 'verified',
    verifierId: 'verifier-1',
    rationale: 'Independent evidence supports the mechanism.',
    evidenceRefs: ['evidence-1'],
    decidedAt: '2026-07-29T00:00:02.000Z',
  };
  const decoded = JSON.parse(JSON.stringify(finding)) as AssuranceFinding;
  assert.equal(decoded.state, 'verified');
  assert.equal(decoded.verifier?.state, 'verified');
  assert.deepEqual(decoded.verifier?.evidenceRefs, ['evidence-1']);
});

test('program constants preserve the three distinct assurance authorities', () => {
  assert.deepEqual(REPOSITORY_ASSURANCE_PROGRAMS, [
    'code_review',
    'security_review',
    'authorized_pentest',
  ]);
});

test('legacy reviews and root entrypoints retain the canonical contract exports', () => {
  assert.equal(REVIEW_COMPAT_PROGRAMS, ROOT_COMPAT_PROGRAMS);
  assert.deepEqual(REVIEW_COMPAT_PROGRAMS, [
    'code_review',
    'security_review',
    'authorized_pentest',
  ]);
});
