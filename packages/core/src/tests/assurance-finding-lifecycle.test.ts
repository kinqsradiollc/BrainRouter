/**
 * A25-8b — Core finding identity, lifecycle, and program-authority fixtures.
 *
 * Line movement and conservative paraphrases retain identity; incomplete runs
 * never auto-fix; each program keeps its own authorization/evidence authority.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findingFingerprint,
  reconcileFindingLifecycle,
  repositoryAssuranceProgramForLens,
  repositoryAssuranceProgramPolicy,
  type LifecycleCurrentFinding,
  type LifecycleFindingInput,
} from '../review/index.js';

function finding(overrides: Partial<LifecycleFindingInput> = {}): LifecycleFindingInput {
  return {
    file: 'src/render.ts',
    line: 12,
    severity: 'high',
    title: '[CWE-79] Unsanitized user input reaches the HTML response',
    cwe: 'CWE-79',
    ...overrides,
  };
}

function current(overrides: Partial<LifecycleCurrentFinding> = {}): LifecycleCurrentFinding {
  const source = finding();
  return {
    id: 'finding-1',
    fingerprint: findingFingerprint('security', source),
    file: source.file,
    title: source.title,
    cwe: source.cwe,
    status: 'open',
    ...overrides,
  };
}

test('A25-8b finding identity ignores line movement but retains program separation', () => {
  assert.equal(
    findingFingerprint('security', finding({ line: 12 })),
    findingFingerprint('security', finding({ line: 98 })),
  );
  assert.notEqual(
    findingFingerprint('security', finding()),
    findingFingerprint('code', finding()),
  );
});

test('A25-8b lifecycle discovers, observes, and conservatively paraphrase-matches', () => {
  const discovered = reconcileFindingLifecycle({
    lens: 'security',
    previous: [],
    incoming: [finding()],
    complete: true,
  });
  assert.equal(discovered.transitions[0]?.type, 'discovered');

  const observed = reconcileFindingLifecycle({
    lens: 'security',
    previous: [current()],
    incoming: [finding({
      title: 'User input reaches the HTML response without sanitization',
      line: 55,
    })],
    complete: true,
  });
  assert.equal(observed.transitions[0]?.type, 'observed');
  assert.equal(observed.transitions[0]?.findingId, 'finding-1');
});

test('A25-8b only a complete review may auto-fix an absent finding', () => {
  assert.deepEqual(reconcileFindingLifecycle({
    lens: 'security',
    previous: [current()],
    incoming: [],
    complete: false,
  }).transitions, []);
  assert.deepEqual(reconcileFindingLifecycle({
    lens: 'security',
    previous: [current()],
    incoming: [],
    complete: true,
  }).transitions.map((transition) => transition.type), ['fixed']);
});

test('A25-8b fixed findings reopen while explicit ignored state remains durable', () => {
  assert.equal(reconcileFindingLifecycle({
    lens: 'security',
    previous: [current({ status: 'fixed' })],
    incoming: [finding({ line: 72 })],
    complete: true,
  }).transitions[0]?.type, 'reopened');
  assert.deepEqual(reconcileFindingLifecycle({
    lens: 'security',
    previous: [current({ status: 'ignored' })],
    incoming: [],
    complete: true,
  }).transitions, []);
});

test('A25-8b legacy lenses map only to their matching assurance programs', () => {
  assert.equal(repositoryAssuranceProgramForLens('code'), 'code_review');
  assert.equal(repositoryAssuranceProgramForLens('security'), 'security_review');
  assert.equal(repositoryAssuranceProgramForLens('pentest'), 'authorized_pentest');
  assert.equal(repositoryAssuranceProgramForLens('unknown'), null);
});

test('A25-8b program defaults preserve distinct authority and evidence bars', () => {
  assert.deepEqual(repositoryAssuranceProgramPolicy('code_review'), {
    program: 'code_review',
    authorization: 'repository_read',
    publication: 'advisory',
    minimumEvidence: 'source_anchor',
    blockingAuthority: 'none',
  });
  assert.deepEqual(repositoryAssuranceProgramPolicy('security_review'), {
    program: 'security_review',
    authorization: 'security_review',
    publication: 'verified_findings',
    minimumEvidence: 'independent_verification',
    blockingAuthority: 'policy_gated',
  });
  assert.deepEqual(repositoryAssuranceProgramPolicy('authorized_pentest'), {
    program: 'authorized_pentest',
    authorization: 'explicit_target_authorization',
    publication: 'restricted_report',
    minimumEvidence: 'reproduction_receipt',
    blockingAuthority: 'explicit_policy_only',
  });
});
