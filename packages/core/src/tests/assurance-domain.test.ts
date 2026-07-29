import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AssuranceFinding,
  RepositoryAssuranceProgram,
  RepositoryAssuranceRun,
} from '@kinqs/brainrouter-types/review';
import {
  calculateAssuranceGate,
  coverageSupportsCleanConclusion,
  findingHasBlockingEvidence,
  validateRepositoryAssuranceRun,
} from '../review/index.js';

function run(
  program: RepositoryAssuranceProgram = 'security_review',
): RepositoryAssuranceRun {
  return {
    id: 'run-1',
    repository: { forge: 'github', slug: 'owner/repository' },
    revision: { baseSha: 'base', headSha: 'head' },
    program,
    policySnapshot: {
      id: 'policy-1',
      policyHash: 'sha256:policy',
      organizationId: 'org-1',
      program,
      analyzers: [{ id: 'typescript', enabled: true, required: true }],
      packetLimits: { maxPackets: 8, maxPacketBytes: 64_000, maxFilesPerPacket: 24 },
      budgets: { maxModelCalls: 10, maxToolCalls: 30, maxDurationMs: 300_000 },
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
      fileCount: 3,
      textFileCount: 3,
      indexedFileCount: 3,
      unsupportedFileCount: 0,
      createdAt: '2026-07-29T00:00:00.000Z',
      completedAt: '2026-07-29T00:00:01.000Z',
    },
    coverage: {
      status: 'complete',
      filesTotal: 3,
      filesEligible: 3,
      filesAnalyzed: 3,
      changedFilesTotal: 1,
      changedFilesAnalyzed: 1,
      analyzers: [{
        analyzerId: 'typescript',
        state: 'covered',
        supportedLanguages: ['typescript'],
        filesEligible: 3,
        filesAnalyzed: 3,
        diagnosticsProduced: 0,
        limitationIds: [],
      }],
      limitations: [],
      calculatedAt: '2026-07-29T00:00:02.000Z',
    },
    stages: [{
      id: 'stage-1',
      stage: 'authorize',
      status: 'succeeded',
      attempt: 1,
      startedAt: '2026-07-29T00:00:00.000Z',
      completedAt: '2026-07-29T00:00:01.000Z',
      inputRefs: [],
      outputRefs: ['authorization-1'],
      limitationIds: [],
    }],
    findings: [],
    status: 'completed',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:02.000Z',
    completedAt: '2026-07-29T00:00:02.000Z',
  };
}

function finding(
  program: RepositoryAssuranceProgram = 'security_review',
): AssuranceFinding {
  return {
    id: 'finding-1',
    fingerprint: 'fingerprint-1',
    program,
    revisionSha: 'head',
    state: 'candidate',
    severity: 'high',
    confidence: 0.95,
    title: 'Candidate issue',
    mechanism: 'Untrusted data may reach a sensitive operation.',
    location: { path: 'src/example.ts', line: 10, symbol: 'execute' },
    evidence: [],
    provenance: [],
    coverageLimitations: [],
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  };
}

function verify(value: AssuranceFinding): AssuranceFinding {
  value.state = 'verified';
  value.evidence = [{
    id: 'evidence-1',
    kind: 'call_path',
    summary: 'Parser-backed path reaches the sensitive operation.',
    revisionSha: 'head',
    createdAt: '2026-07-29T00:00:01.000Z',
  }];
  value.provenance = [{
    producerKind: 'deterministic_analyzer',
    producerId: 'analyzer-1',
    policyHash: 'sha256:policy',
    createdAt: '2026-07-29T00:00:01.000Z',
  }];
  value.verifier = {
    state: 'verified',
    verifierId: 'verifier-1',
    rationale: 'Independent evidence supports the mechanism.',
    evidenceRefs: ['evidence-1'],
    decidedAt: '2026-07-29T00:00:02.000Z',
  };
  return value;
}

function attach(value: RepositoryAssuranceRun, item: AssuranceFinding): void {
  value.findings.push({
    id: item.id,
    fingerprint: item.fingerprint,
    state: item.state,
    severity: item.severity,
  });
}

test('assurance validation accepts a complete exact-revision run', () => {
  assert.deepEqual(validateRepositoryAssuranceRun(run()), { ok: true, issues: [] });
});

test('assurance validation rejects authority and source-revision mismatches', () => {
  const value = run();
  value.policySnapshot.program = 'code_review';
  value.sourceSnapshot.revision.headSha = 'other';
  value.coverage.filesAnalyzed = 4;
  const result = validateRepositoryAssuranceRun(value);
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /policySnapshot\.program must match/);
  assert.match(result.issues.join('\n'), /sourceSnapshot\.revision\.headSha must match/);
  assert.match(result.issues.join('\n'), /filesAnalyzed cannot exceed/);
});

test('assurance validation rejects secret-bearing extension fields at any depth', () => {
  const value = run() as RepositoryAssuranceRun & {
    adapter?: { nested?: { access_token?: string } };
  };
  value.adapter = { nested: { access_token: 'must-not-cross-the-boundary' } };
  const result = validateRepositoryAssuranceRun(value);
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /access_token is forbidden/);
  assert.doesNotMatch(JSON.stringify(result), /must-not-cross-the-boundary/);
});

test('stale and superseded runs require explicit lifecycle evidence', () => {
  const stale = run();
  stale.status = 'stale';
  delete stale.staleReason;
  assert.match(validateRepositoryAssuranceRun(stale).issues.join('\n'), /staleReason/);

  const superseded = run();
  superseded.status = 'superseded';
  delete superseded.supersededByRunId;
  assert.match(validateRepositoryAssuranceRun(superseded).issues.join('\n'), /supersededByRunId/);
});

test('coverage limitations prevent a clean conclusion', () => {
  const value = run();
  assert.equal(coverageSupportsCleanConclusion(value.coverage), true);
  value.coverage.status = 'partial';
  value.coverage.limitations.push({
    id: 'limit-1',
    component: 'typescript',
    state: 'failed',
    reasonCode: 'analyzer_failed',
    summary: 'Analyzer failed.',
  });
  assert.equal(coverageSupportsCleanConclusion(value.coverage), false);
});

test('candidate and unverified assertions never block', () => {
  const value = run();
  const candidate = finding();
  attach(value, candidate);
  const candidateGate = calculateAssuranceGate({
    run: value,
    findings: [candidate],
    currentHeadSha: 'head',
  });
  assert.equal(candidateGate.status, 'advisory');
  assert.equal(candidateGate.blocked, false);
  assert.equal(candidateGate.cleanEligible, false);
  assert.equal(findingHasBlockingEvidence(candidate), false);

  candidate.state = 'verified';
  value.findings[0].state = 'verified';
  assert.equal(findingHasBlockingEvidence(candidate), false);
});

test('verified current-head evidence can block a security review under policy', () => {
  const value = run();
  const supported = verify(finding());
  attach(value, supported);
  const gate = calculateAssuranceGate({
    run: value,
    findings: [supported],
    currentHeadSha: 'head',
  });
  assert.equal(gate.status, 'blocked');
  assert.equal(gate.blocked, true);
  assert.equal(gate.cleanEligible, false);
  assert.deepEqual(gate.blockingFindingIds, ['finding-1']);
});

test('code review remains advisory even with independently supported findings', () => {
  const value = run('code_review');
  const supported = verify(finding('code_review'));
  attach(value, supported);
  const gate = calculateAssuranceGate({
    run: value,
    findings: [supported],
    currentHeadSha: 'head',
  });
  assert.equal(gate.status, 'advisory');
  assert.equal(gate.blocked, false);
  assert.equal(gate.cleanEligible, false);
});

test('partial, superseded, and wrong-head runs cannot produce a clean conclusion', () => {
  const partial = run();
  partial.status = 'partial';
  partial.coverage.status = 'partial';
  assert.equal(calculateAssuranceGate({
    run: partial,
    findings: [],
    currentHeadSha: 'head',
  }).cleanEligible, false);

  const superseded = run();
  superseded.status = 'superseded';
  superseded.supersededByRunId = 'run-2';
  assert.equal(calculateAssuranceGate({
    run: superseded,
    findings: [],
    currentHeadSha: 'head',
  }).status, 'superseded');

  assert.equal(calculateAssuranceGate({
    run: run(),
    findings: [],
    currentHeadSha: 'new-head',
  }).status, 'stale');
});

test('supported findings stay advisory when blocking policy is disabled', () => {
  const value = run();
  value.policySnapshot.blockingEnabled = false;
  const supported = verify(finding());
  attach(value, supported);
  const gate = calculateAssuranceGate({
    run: value,
    findings: [supported],
    currentHeadSha: 'head',
  });
  assert.equal(gate.status, 'advisory');
  assert.equal(gate.blocked, false);
  assert.equal(gate.cleanEligible, false);
});

test('missing or mismatched finding records make the gate partial, never clean', () => {
  const value = run();
  const candidate = finding();
  attach(value, candidate);
  assert.equal(calculateAssuranceGate({
    run: value,
    findings: [],
    currentHeadSha: 'head',
  }).status, 'partial');

  const mismatched = { ...candidate, fingerprint: 'other' };
  assert.equal(calculateAssuranceGate({
    run: value,
    findings: [mismatched],
    currentHeadSha: 'head',
  }).status, 'partial');
});
