/**
 * ADR-032 D1/D8 — adversarial tests for Desktop's trusted correction ingress.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { LearnedItem } from '@kinqs/brainrouter-core/learning';
import {
  createAuthenticatedHumanCorrectionIngress,
  HUMAN_CORRECTION_FIELD_LIMITS,
  type AuthenticatedCorrectionBinding,
  type HumanCorrectionRecordInput,
} from './humanCorrectionIngress.js';

const fields = {
  statement: 'Run the focused tenant test before reporting this change complete.',
  falsifier: 'The focused test does not exercise the changed tenant boundary.',
  expectation: 'Tenant regressions are caught before handoff.',
};

const binding = (overrides: Partial<AuthenticatedCorrectionBinding> = {}): AuthenticatedCorrectionBinding => ({
  authenticated: true,
  accountUserId: 'user-live',
  accountOrgId: 'org-live',
  tenant: { userId: 'user-live', orgId: 'org-live' },
  sessionKey: 'session-live',
  bindingError: null,
  ...overrides,
});

const admittedItem = (input: HumanCorrectionRecordInput): LearnedItem => ({
  id: 'learned-human-1',
  tenant: input.tenant,
  tier: 'instruction',
  origin: 'human-correction',
  form: 'lesson',
  statement: input.statement,
  falsifier: input.falsifier,
  outcome: { expectation: input.expectation, retrievals: 0, confirmations: 0, contradictions: 0 },
  provenance: {
    sessionKey: input.sessionKey,
    capturedAt: '2026-08-09T00:00:00.000Z',
    checkpoint: 'session-end',
    evidence: [`corrected in session ${input.sessionKey}`],
    corroboratedByTrustedAction: true,
    sawUntrustedContent: false,
    gateReasoning: 'human correction',
  },
  status: 'active',
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
});

test('host stamps authenticated tenant and session and drops forged provenance', () => {
  let received: HumanCorrectionRecordInput | undefined;
  const ingress = createAuthenticatedHumanCorrectionIngress({
    readBinding: () => binding(),
    record: (input) => {
      received = input;
      return { admitted: true, item: admittedItem(input) };
    },
  });

  const result = ingress.record({
    ...fields,
    userId: 'attacker-user',
    orgId: 'attacker-org',
    sessionKey: 'attacker-session',
    tenant: { userId: 'attacker-user', orgId: 'attacker-org' },
    tier: 'instruction',
    origin: 'model-inferred',
    provenance: { evidence: ['forged'] },
  });

  assert.equal(result.admitted, true);
  assert.deepEqual(received, {
    tenant: { userId: 'user-live', orgId: 'org-live' },
    sessionKey: 'session-live',
    ...fields,
  });
  assert.deepEqual(Object.keys(received ?? {}).sort(), [
    'expectation', 'falsifier', 'sessionKey', 'statement', 'tenant',
  ]);
});

test('signed-out and incomplete authenticated identities fail closed', () => {
  let calls = 0;
  const cases: AuthenticatedCorrectionBinding[] = [
    binding({ authenticated: false }),
    binding({ accountUserId: '' }),
    binding({ accountOrgId: '' }),
    binding({ sessionKey: '' }),
  ];
  for (const candidate of cases) {
    const ingress = createAuthenticatedHumanCorrectionIngress({
      readBinding: () => candidate,
      record: (input) => { calls += 1; return { admitted: true, item: admittedItem(input) }; },
    });
    assert.equal(ingress.availability().allowed, false);
    assert.equal(ingress.record(fields).admitted, false);
  }
  assert.equal(calls, 0);
});

test('stale user, stale organization, and host binding drift fail closed', () => {
  let calls = 0;
  const cases: AuthenticatedCorrectionBinding[] = [
    binding({ tenant: { userId: 'user-old', orgId: 'org-live' } }),
    binding({ tenant: { userId: 'user-live', orgId: 'org-old' } }),
    binding({ bindingError: 'organization switch still applying' }),
  ];
  for (const candidate of cases) {
    const ingress = createAuthenticatedHumanCorrectionIngress({
      readBinding: () => candidate,
      record: (input) => { calls += 1; return { admitted: true, item: admittedItem(input) }; },
    });
    assert.equal(ingress.availability().allowed, false);
    const result = ingress.record(fields);
    assert.equal(result.admitted, false);
    if (!result.admitted) assert.equal(result.rule, 'unauthorized');
  }
  assert.equal(calls, 0);
});

test('missing, non-string, and oversized fields never reach the recorder', () => {
  let calls = 0;
  const ingress = createAuthenticatedHumanCorrectionIngress({
    readBinding: () => binding(),
    record: (input) => { calls += 1; return { admitted: true, item: admittedItem(input) }; },
  });
  const cases: Array<Record<string, unknown>> = [
    { ...fields, statement: '' },
    { ...fields, falsifier: 42 },
    { ...fields, expectation: 'x'.repeat(HUMAN_CORRECTION_FIELD_LIMITS.expectation + 1) },
  ];
  for (const candidate of cases) {
    const result = ingress.record(candidate);
    assert.equal(result.admitted, false);
    if (!result.admitted) assert.equal(result.rule, 'malformed');
  }
  assert.equal(calls, 0);
});

test('the core recorder gate result passes through unchanged', () => {
  const rejected = { admitted: false as const, rule: 'unfalsifiable', reason: 'name a contrary observation' };
  const ingress = createAuthenticatedHumanCorrectionIngress({
    readBinding: () => binding(),
    record: () => rejected,
  });
  assert.strictEqual(ingress.record(fields), rejected);
});
