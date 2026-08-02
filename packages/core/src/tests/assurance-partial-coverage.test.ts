/**
 * ADR-027 D9.1 — partial evidence is REPORTED, not treated as a merge failure.
 *
 * Context for whoever reads this next, because the change loosened a security
 * gate and that deserves scrutiny rather than trust:
 *
 * The gate blocked on `partial` coverage regardless of whether anything was
 * found. Repository context is routinely unavailable (the reviewer falls back
 * to a diff-only pass), so coverage is routinely partial, so the check failed on
 * every pull request while reporting "No security issues found". A gate that can
 * never go green is one people switch off, and a disabled gate reviews nothing.
 *
 * What did NOT change: stale, running, failed, canceled, superseded, and partial
 * coverage that produced findings all still block. The shortfall is still
 * reported — `status` remains `partial` and the reason says so. Only the merge
 * verdict changed, and only for the case where there is nothing to say.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAssuranceGate } from '../review/domain/assuranceGate.js';

const HEAD = 'abc123';

function run(over: Record<string, unknown> = {}): any {
  return {
    program: 'security_review',
    status: 'complete',
    revision: { headSha: HEAD },
    policySnapshot: { blockingEnabled: true },
    coverage: {
      status: 'complete',
      limitations: [],
      filesEligible: 10,
      filesAnalyzed: 10,
      changedFilesTotal: 3,
      changedFilesAnalyzed: 3,
      analyzers: [{ id: 'security', state: 'covered' }],
    },
    findings: [],
    ...over,
  };
}

function finding(over: Record<string, unknown> = {}): any {
  return {
    id: 'f1',
    program: 'security_review',
    revisionSha: HEAD,
    severity: 'high',
    state: 'candidate',
    fingerprint: 'fp1',
    evidence: [],
    verifier: { evidenceRefs: [] },
    ...over,
  };
}

test('partial evidence with NO findings does not block the merge', () => {
  const gate = calculateAssuranceGate({
    run: run({ status: 'partial' }),
    findings: [],
    currentHeadSha: HEAD,
  });
  assert.equal(gate.blocked, false, 'nothing was found; there is nothing to block on');
  assert.equal(gate.status, 'partial', 'the shortfall is still reported, not hidden');
  assert.equal(gate.cleanEligible, false, 'and it is not claimed to be clean either');
  assert.match(gate.reason, /partial evidence/i);
});

test('partial evidence WITH findings still blocks', () => {
  // Reduced coverage plus something to say is the case the gate exists for.
  const gate = calculateAssuranceGate({
    run: run({ status: 'partial' }),
    findings: [finding()],
    currentHeadSha: HEAD,
  });
  assert.equal(gate.blocked, true);
  assert.match(gate.reason, /finding\(s\) needing disposition/);
});

test('a stale run still blocks, findings or not', () => {
  // The review describes different code; "no issues" says nothing about this.
  const gate = calculateAssuranceGate({
    run: run({ revision: { headSha: 'other' } }),
    findings: [],
    currentHeadSha: HEAD,
  });
  assert.equal(gate.blocked, true);
  assert.equal(gate.status, 'stale');
});

test('a still-running or failed run blocks', () => {
  for (const status of ['running', 'queued', 'failed'] as const) {
    const gate = calculateAssuranceGate({
      run: run({ status }),
      findings: [],
      currentHeadSha: HEAD,
    });
    assert.equal(gate.blocked, true, `status "${status}" must block`);
  }
});

test('with blocking disabled, nothing blocks — the knob still works', () => {
  const gate = calculateAssuranceGate({
    run: run({ status: 'partial', policySnapshot: { blockingEnabled: false } }),
    findings: [finding()],
    currentHeadSha: HEAD,
  });
  assert.equal(gate.blocked, false);
});

test('a finding from a DIFFERENT revision does not resurrect the block', () => {
  // Otherwise a stale finding row would wedge an unrelated head forever.
  const gate = calculateAssuranceGate({
    run: run({ status: 'partial' }),
    findings: [finding({ revisionSha: 'older' })],
    currentHeadSha: HEAD,
  });
  assert.equal(gate.blocked, false);
});

test('complete coverage with no findings is still the only CLEAN outcome', () => {
  // Partial must not be silently promoted to clean; that would be the
  // dishonest version of this fix.
  const gate = calculateAssuranceGate({ run: run(), findings: [], currentHeadSha: HEAD });
  assert.equal(gate.cleanEligible, true);
  assert.equal(gate.status, 'clean');
});
