import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionIntentHandle } from '@kinqs/brainrouter-types/agent';
import {
  activateExecutionIntent,
  consumeExecutionDispatchReceipt,
  consumeExecutionIntent,
  createExecutionDispatchReceipt,
  createExecutionIntentOwnerToken,
  expireExecutionIntent,
  issueExecutionIntent,
  rejectExecutionDispatchReceipt,
  validateExecutionIntent,
} from '../orchestration/execution/authority.js';
import {
  normalizePhasePlanExecutionTarget,
  normalizeWorkflowGraphExecutionTarget,
  readExecutionIntentRecord,
} from '../orchestration/execution/index.js';

const identity = {
  workspaceRoot: '/workspace/repo',
  sessionKey: 'session-1',
  userId: 'user-1',
};
const now = Date.parse('2026-08-13T00:00:00.000Z');

function phaseTarget(task = 'Implement the bounded authority contract') {
  const result = normalizePhasePlanExecutionTarget({
    template: 'build',
    templateArgs: { task },
    slug: 'authority-build',
    background: false,
  });
  assert.equal(result.ok, true, result.ok ? undefined : result.errors.join('\n'));
  return result.target;
}

let receiptSequence = 0;
function mintDispatchReceipt(task = 'Dispatch the reviewed target') {
  receiptSequence += 1;
  const suffix = String(receiptSequence);
  const target = phaseTarget(`${task} ${suffix}`);
  const owner = createExecutionIntentOwnerToken(identity);
  const turnId = `turn-receipt-${suffix}`;
  const handle = issueExecutionIntent(owner, {
    source: 'user-command',
    requestId: `request-receipt-${suffix}`,
    turnId,
    target,
    now,
  });
  assert.equal(activateExecutionIntent(owner, handle, {
    ...identity,
    turnId,
    now,
  }).ok, true);
  const consumed = consumeExecutionIntent(owner, handle, {
    ...identity,
    source: 'user-command',
    requestId: `request-receipt-${suffix}`,
    turnId,
    target,
    now,
  });
  if (!consumed.ok) assert.fail(consumed.reason);
  const runId = `run-receipt-${suffix}`;
  const receipt = createExecutionDispatchReceipt(owner, handle, {
    runId,
    parentExecutionId: turnId,
    assertAuthorityCurrent: () => {},
  });
  return {
    receipt,
    input: {
      record: consumed.record,
      runId,
      parentExecutionId: turnId,
      target,
    },
  };
}

test('ADR-040 A40-2 intent authority activates once and dispatches only its frozen canonical phase plan', () => {
  const raw = {
    plan: {
      title: 'Bounded review',
      phases: [{
        id: 'review',
        agents: [{ prompt: 'Review the exact change' }],
      }],
    },
    slug: 'Review Run',
    background: false,
  };
  const normalized = normalizePhasePlanExecutionTarget(raw);
  assert.equal(normalized.ok, true, normalized.ok ? undefined : normalized.errors.join('\n'));
  if (!normalized.ok) return;

  const owner = createExecutionIntentOwnerToken(identity);
  const handle = issueExecutionIntent(owner, {
    source: 'user-command',
    requestId: 'request-1',
    turnId: 'turn-1',
    target: normalized.target,
    now,
  });

  raw.plan.phases[0]!.agents[0]!.prompt = 'MUTATED AFTER AUTHORIZATION';
  assert.equal(Object.isFrozen(handle), true);
  assert.equal(JSON.stringify(handle), '{}');
  const record = readExecutionIntentRecord(handle);
  assert.ok(record);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.target), true);
  assert.deepEqual(record.target, {
    topology: 'phase-plan',
    slug: 'review-run',
    background: false,
    resume: null,
    template: null,
    definitionDigest: record.target.topology === 'phase-plan'
      ? record.target.definitionDigest
      : '',
  });
  assert.match(record.target.topology === 'phase-plan' ? record.target.definitionDigest : '', /^[a-f0-9]{64}$/);
  assert.equal('definition' in record.target, false);

  assert.equal(activateExecutionIntent(owner, handle, {
    ...identity,
    turnId: 'turn-1',
    now,
  }).ok, true);
  assert.equal(activateExecutionIntent(owner, handle, {
    ...identity,
    turnId: 'turn-1',
    now,
  }).ok, false, 'a turn cannot activate the same bearer twice');

  const equivalent = normalizePhasePlanExecutionTarget({
    plan: {
      title: 'Bounded review',
      phases: [{
        id: 'review',
        agents: [{ prompt: 'Review the exact change' }],
      }],
    },
    slug: 'Review Run',
    background: false,
  });
  assert.equal(equivalent.ok, true);
  if (!equivalent.ok) return;
  const consumed = consumeExecutionIntent(owner, handle, {
    ...identity,
    source: 'user-command',
    requestId: 'request-1',
    turnId: 'turn-1',
    target: equivalent.target,
    now,
  });
  assert.equal(consumed.ok, true, consumed.ok ? undefined : consumed.reason);
  if (!consumed.ok) return;
  assert.equal(Object.isFrozen(consumed.dispatchArgs), true);
  const plan = consumed.dispatchArgs.plan as {
    phases: Array<{ agents: Array<{ prompt: string; access: string }> }>;
  };
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.phases[0]!.agents[0]!), true);
  assert.equal(plan.phases[0]!.agents[0]!.prompt, 'Review the exact change');
  assert.equal(plan.phases[0]!.agents[0]!.access, 'read');
  assert.throws(() => {
    plan.phases[0]!.agents[0]!.prompt = 'mutate canonical dispatch';
  }, /read only|Cannot assign/i);
  assert.equal(consumeExecutionIntent(owner, handle, {
    ...identity,
    source: 'user-command',
    requestId: 'request-1',
    turnId: 'turn-1',
    target: equivalent.target,
    now,
  }).ok, false, 'consume is one-shot');
});

test('ADR-040 A40-2 clones, JSON, structured clones, mutation, getters, and toJSON never gain intent authority', () => {
  const owner = createExecutionIntentOwnerToken(identity);
  const target = phaseTarget();
  const handle = issueExecutionIntent(owner, {
    source: 'reviewed-ui',
    requestId: 'request-clone',
    turnId: 'turn-clone',
    target,
    now,
  });
  const jsonClone = JSON.parse(JSON.stringify(handle)) as ExecutionIntentHandle;
  const structureClone = structuredClone(handle) as ExecutionIntentHandle;
  assert.equal(readExecutionIntentRecord(jsonClone), null);
  assert.equal(readExecutionIntentRecord(structureClone), null);
  assert.equal(activateExecutionIntent(owner, jsonClone, {
    ...identity,
    turnId: 'turn-clone',
    now,
  }).ok, false);
  assert.equal(activateExecutionIntent(owner, structureClone, {
    ...identity,
    turnId: 'turn-clone',
    now,
  }).ok, false);

  let getterCalls = 0;
  const accessorArgs = {};
  Object.defineProperty(accessorArgs, 'plan', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { phases: [] };
    },
  });
  const accessorResult = normalizePhasePlanExecutionTarget(accessorArgs);
  assert.equal(accessorResult.ok, false);
  assert.equal(getterCalls, 0, 'normalization must inspect descriptors, not execute getters');

  let toJsonCalls = 0;
  const toJsonResult = normalizePhasePlanExecutionTarget({
    plan: {
      phases: [],
      toJSON() {
        toJsonCalls += 1;
        return { phases: [{ id: 'forged', agents: [{ prompt: 'forged' }] }] };
      },
    },
  });
  assert.equal(toJsonResult.ok, false);
  assert.equal(toJsonCalls, 0, 'normalization must never execute toJSON');
});

test('ADR-040 A40-2 owner, turn, identity, expiry, target, and replay mismatches fail closed', () => {
  const owner = createExecutionIntentOwnerToken(identity);
  const lookalikeOwner = createExecutionIntentOwnerToken(identity);
  const target = normalizePhasePlanExecutionTarget({
    template: 'build',
    templateArgs: { task: 'delivery' },
    slug: 'delivery',
  });
  assert.equal(target.ok, true);
  if (!target.ok) return;
  const handle = issueExecutionIntent(owner, {
    source: 'user-command',
    requestId: 'request-bound',
    turnId: 'turn-bound',
    target: target.target,
    now,
    ttlMs: 1_000,
  });

  const wrongOwner = activateExecutionIntent(lookalikeOwner, handle, {
    ...identity,
    turnId: 'turn-bound',
    now,
  });
  assert.deepEqual(wrongOwner, { ok: false, reason: 'owner-mismatch' });
  assert.equal(activateExecutionIntent(owner, handle, {
    ...identity,
    turnId: 'turn-bound',
    now,
  }).ok, true, 'wrong-owner access cannot consume or burn the real owner capability');

  const mismatchedTarget = normalizePhasePlanExecutionTarget({
    template: 'build',
    templateArgs: { task: 'quality' },
    slug: 'quality',
  });
  assert.equal(mismatchedTarget.ok, true);
  if (!mismatchedTarget.ok) return;
  assert.deepEqual(consumeExecutionIntent(owner, handle, {
    ...identity,
    source: 'user-command',
    requestId: 'request-bound',
    turnId: 'turn-bound',
    target: mismatchedTarget.target,
    now,
  }), { ok: false, reason: 'target-mismatch' });
  assert.equal(consumeExecutionIntent(owner, handle, {
    ...identity,
    source: 'user-command',
    requestId: 'request-bound',
    turnId: 'turn-bound',
    target: target.target,
    now,
  }).ok, false, 'a failed same-owner consume burns the bearer');

  const expired = issueExecutionIntent(owner, {
    source: 'user-command',
    requestId: 'request-expired',
    turnId: 'turn-expired',
    target: target.target,
    now,
    ttlMs: 1_000,
  });
  assert.deepEqual(activateExecutionIntent(owner, expired, {
    ...identity,
    turnId: 'turn-expired',
    now: now + 1_001,
  }), { ok: false, reason: 'expired' });

  const wrongBinding = issueExecutionIntent(owner, {
    source: 'user-command',
    requestId: 'request-wrong-binding',
    turnId: 'turn-wrong-binding',
    target: target.target,
    now,
  });
  assert.deepEqual(activateExecutionIntent(owner, wrongBinding, {
    ...identity,
    sessionKey: 'other-session',
    turnId: 'turn-wrong-binding',
    now,
  }), { ok: false, reason: 'binding-mismatch' });
  assert.equal(activateExecutionIntent(owner, wrongBinding, {
    ...identity,
    turnId: 'turn-wrong-binding',
    now,
  }).ok, false, 'a same-owner identity mismatch burns the bearer');

  const ended = issueExecutionIntent(owner, {
    source: 'user-command',
    requestId: 'request-ended',
    turnId: 'turn-ended',
    target: target.target,
    now,
  });
  assert.equal(activateExecutionIntent(owner, ended, {
    ...identity,
    turnId: 'turn-ended',
    now,
  }).ok, true);
  expireExecutionIntent(owner, ended, 'turn-ended');
  assert.equal(consumeExecutionIntent(owner, ended, {
    ...identity,
    source: 'user-command',
    requestId: 'request-ended',
    turnId: 'turn-ended',
    target: target.target,
    now,
  }).ok, false);

  assert.throws(() => issueExecutionIntent(owner, {
    source: 'forged-source' as 'user-command',
    requestId: 'request-forged-source',
    turnId: 'turn-forged-source',
    target: target.target,
    now,
  }), /source is not recognized/);
  assert.throws(() => issueExecutionIntent(owner, {
    source: 'user-command',
    requestId: 'x'.repeat(257),
    turnId: 'turn-bounded',
    target: target.target,
    now,
  }), /at most 128 safe characters/);
});

test('ADR-040 A40-2 pre-hook validation is non-consuming on an exact target and burns a mismatch', () => {
  const owner = createExecutionIntentOwnerToken(identity);
  const exact = phaseTarget('exact pre-hook target');
  const handle = issueExecutionIntent(owner, {
    source: 'user-command',
    requestId: 'request-preflight',
    turnId: 'turn-preflight',
    target: exact,
    now,
  });
  assert.equal(activateExecutionIntent(owner, handle, {
    ...identity,
    turnId: 'turn-preflight',
    now,
  }).ok, true);
  assert.equal(validateExecutionIntent(owner, handle, {
    ...identity,
    source: 'user-command',
    requestId: 'request-preflight',
    turnId: 'turn-preflight',
    target: exact,
    now,
  }).ok, true);
  assert.equal(consumeExecutionIntent(owner, handle, {
    ...identity,
    source: 'user-command',
    requestId: 'request-preflight',
    turnId: 'turn-preflight',
    target: exact,
    now,
  }).ok, true, 'an exact preflight does not consume the bearer');

  const mismatchHandle = issueExecutionIntent(owner, {
    source: 'user-command',
    requestId: 'request-mismatch-preflight',
    turnId: 'turn-mismatch-preflight',
    target: exact,
    now,
  });
  assert.equal(activateExecutionIntent(owner, mismatchHandle, {
    ...identity,
    turnId: 'turn-mismatch-preflight',
    now,
  }).ok, true);
  const mismatch = phaseTarget('different pre-hook target');
  assert.deepEqual(validateExecutionIntent(owner, mismatchHandle, {
    ...identity,
    source: 'user-command',
    requestId: 'request-mismatch-preflight',
    turnId: 'turn-mismatch-preflight',
    target: mismatch,
    now,
  }), { ok: false, reason: 'target-mismatch' });
  assert.equal(consumeExecutionIntent(owner, mismatchHandle, {
    ...identity,
    source: 'user-command',
    requestId: 'request-mismatch-preflight',
    turnId: 'turn-mismatch-preflight',
    target: exact,
    now,
  }).ok, false);
});

test('ADR-040 A40-2 dispatch receipt lookalikes, serialization, and structured clones have no authority', () => {
  const { receipt, input } = mintDispatchReceipt('Reject receipt clones');
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized, '{}');
  const candidates: unknown[] = [
    Object.freeze({}),
    serialized,
    JSON.parse(serialized),
    structuredClone(receipt),
  ];

  for (const candidate of candidates) {
    assert.throws(
      () => consumeExecutionDispatchReceipt(candidate, input),
      /unforgeable|unknown or already consumed/i,
    );
  }
  assert.doesNotThrow(
    () => consumeExecutionDispatchReceipt(receipt, input),
    'lookalike attempts cannot burn the genuine receipt',
  );
});

test('ADR-040 A40-2 dispatch receipt consumption is one-shot and rejects replay', () => {
  const { receipt, input } = mintDispatchReceipt('Reject receipt replay');
  consumeExecutionDispatchReceipt(receipt, input);
  assert.throws(
    () => consumeExecutionDispatchReceipt(receipt, input),
    /unknown or already consumed/i,
  );
});

test('ADR-040 A40-2 a target, run, or parent mismatch burns the genuine dispatch receipt', () => {
  const cases = [
    {
      label: 'target',
      mismatch: (input: ReturnType<typeof mintDispatchReceipt>['input']) => ({
        ...input,
        target: phaseTarget('Mismatched dispatch target'),
      }),
    },
    {
      label: 'runId',
      mismatch: (input: ReturnType<typeof mintDispatchReceipt>['input']) => ({
        ...input,
        runId: `${input.runId}-mismatch`,
      }),
    },
    {
      label: 'parentExecutionId',
      mismatch: (input: ReturnType<typeof mintDispatchReceipt>['input']) => ({
        ...input,
        parentExecutionId: `${input.parentExecutionId}-mismatch`,
      }),
    },
  ];

  for (const entry of cases) {
    const { receipt, input } = mintDispatchReceipt(`Burn receipt on ${entry.label} mismatch`);
    assert.throws(
      () => consumeExecutionDispatchReceipt(receipt, entry.mismatch(input)),
      /mismatched, or already consumed/i,
    );
    assert.throws(
      () => consumeExecutionDispatchReceipt(receipt, input),
      /unknown or already consumed/i,
      `${entry.label} mismatch must permanently burn the genuine receipt`,
    );
  }
});

test('ADR-040 A40-2 explicitly rejecting a dispatch receipt permanently burns it', () => {
  const { receipt, input } = mintDispatchReceipt('Reject receipt explicitly');
  rejectExecutionDispatchReceipt(receipt);
  assert.throws(
    () => consumeExecutionDispatchReceipt(receipt, input),
    /unknown or already consumed/i,
  );
});

test('ADR-040 A40-2 graph normalization binds a content-free record to a protected definition and input snapshot', () => {
  const raw = {
    graphId: 'review-graph',
    graphRevision: 'revision-7',
    definition: {
      id: 'review-graph',
      nodes: [
        { id: 'start', type: 'trigger' },
        { id: 'result', type: 'output', data: { template: '{{$vars.answer}}' } },
      ],
      edges: [{ id: 'edge-1', source: 'start', target: 'result' }],
    },
    vars: { answer: 'approved input' },
  };
  const result = normalizeWorkflowGraphExecutionTarget(raw);
  assert.equal(result.ok, true, result.ok ? undefined : result.errors.join('\n'));
  if (!result.ok) return;
  const owner = createExecutionIntentOwnerToken(identity);
  const handle = issueExecutionIntent(owner, {
    source: 'reviewed-ui',
    requestId: 'request-graph',
    turnId: 'turn-graph',
    target: result.target,
    now,
  });
  const record = readExecutionIntentRecord(handle);
  assert.ok(record);
  assert.deepEqual(record.target, {
    topology: 'workflow-graph',
    graphId: 'review-graph',
    graphRevision: 'revision-7',
    definitionDigest: record.target.topology === 'workflow-graph'
      ? record.target.definitionDigest
      : '',
  });
  assert.equal('definition' in record.target, false);
  assert.equal('vars' in record.target, false);
  raw.definition.nodes[1]!.data!.template = 'MUTATED';
  raw.vars.answer = 'MUTATED';

  assert.equal(activateExecutionIntent(owner, handle, {
    ...identity,
    turnId: 'turn-graph',
    now,
  }).ok, true);
  const consumed = consumeExecutionIntent(owner, handle, {
    ...identity,
    source: 'reviewed-ui',
    requestId: 'request-graph',
    turnId: 'turn-graph',
    target: result.target,
    now,
  });
  assert.equal(consumed.ok, true);
  if (!consumed.ok) return;
  const graph = consumed.dispatchArgs.definition as typeof raw.definition;
  const vars = consumed.dispatchArgs.vars as Record<string, unknown>;
  assert.equal(graph.nodes[1]!.data!.template, '{{$vars.answer}}');
  assert.equal(vars.answer, 'approved input');
  assert.equal(Object.isFrozen(graph.nodes), true);
  assert.equal(Object.isFrozen(vars), true);
});

test('ADR-040 A40-2 phase-run resume remains closed until attempt lineage is durable', () => {
  const result = normalizePhasePlanExecutionTarget({ resume: 'Interrupted Run' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join('\n'), /resume.*durable execution lineage/i);
});

test('ADR-040 A40-2 trusted background and oversized template launches fail before intent issuance', () => {
  const background = normalizePhasePlanExecutionTarget({
    template: 'compare',
    templateArgs: { targets: ['A', 'B'] },
    background: true,
  });
  assert.equal(background.ok, false);
  if (!background.ok) assert.match(background.errors.join('\n'), /background phase runs are not enabled/);

  const oversized = normalizePhasePlanExecutionTarget({
    template: 'compare',
    templateArgs: {
      targets: Array.from({ length: 17 }, (_, index) => `target-${index}`),
    },
  });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.match(oversized.errors.join('\n'), /16-child limit/i);
});

test('ADR-040 A40-2 canonical explicit plans can be normalized again at the receipt chokepoint', () => {
  const first = normalizePhasePlanExecutionTarget({
    plan: {
      title: 'Explicit bounded plan',
      phases: [{ id: 'inspect', agents: [{ prompt: 'Inspect one thing' }] }],
    },
    slug: 'explicit-bounded-plan',
  });
  if (!first.ok) assert.fail(first.errors.join('; '));
  const owner = createExecutionIntentOwnerToken(identity);
  const handle = issueExecutionIntent(owner, {
    source: 'user-command',
    requestId: 'request-explicit-plan',
    turnId: 'turn-explicit-plan',
    target: first.target,
    now,
  });
  assert.equal(activateExecutionIntent(owner, handle, {
    ...identity,
    turnId: 'turn-explicit-plan',
    now,
  }).ok, true);
  const consumed = consumeExecutionIntent(owner, handle, {
    ...identity,
    source: 'user-command',
    requestId: 'request-explicit-plan',
    turnId: 'turn-explicit-plan',
    target: first.target,
    now,
  });
  if (!consumed.ok) assert.fail(consumed.reason);
  const second = normalizePhasePlanExecutionTarget(consumed.dispatchArgs);
  if (!second.ok) assert.fail(second.errors.join('; '));
  assert.deepEqual(second.target.record, first.target.record);
});
