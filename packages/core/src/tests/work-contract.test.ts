/**
 * Work Contract v1 round-trip, migration, and invariant proofs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readPlan, updatePlan } from '../task/taskStore.js';
import {
  createWorkContract,
  readOrMigrateWorkContract,
  readWorkContract,
  reviseWorkContract,
  workContractPath,
} from '../task/workContractStore.js';
import type { WorkTaskRef } from '../task/workContract.js';
import {
  applySteeringPlanRevision,
  beginSteeringReceipt,
  pendingSteeringConstraint,
  reconcileSteeringReceipt,
} from '../task/steeringReceiptStore.js';
import { evaluateSteeringToolGate } from '../task/steeringReconciliationGate.js';
import { withTempWorkspace } from './_helpers.js';

const PLAN_HASH = 'a'.repeat(64);

test('Work Contract migrates an authoritative plan into refs without copying bodies', () => {
  withTempWorkspace((workspace) => {
    const sessionKey = 'session:contract-migration';
    const plan = updatePlan(workspace, {
      requirementId: 'req_contract',
      explanation: 'Do not duplicate this explanation.',
      plan: [{
        step: 'Implement the stable contract.',
        status: 'in_progress',
        acceptance: 'Round-trip tests pass.',
      }],
    }, sessionKey);

    const migrated = readOrMigrateWorkContract(workspace, sessionKey, {
      profileId: 'research',
    });
    assert.ok(migrated);
    assert.equal(migrated.schemaVersion, 1);
    assert.equal(migrated.revision, 1);
    assert.equal(migrated.profileId, 'research');
    assert.equal(migrated.plan.revision, plan.revision);
    assert.equal(migrated.tasks[0].id, plan.items[0].id);
    assert.equal(migrated.tasks[0].readiness, 'implementation_ready');
    assert.deepEqual(migrated.tasks[0].requirementIds, ['req_contract']);

    const serialized = fs.readFileSync(workContractPath(workspace, sessionKey), 'utf8');
    assert.doesNotMatch(serialized, /Implement the stable contract/);
    assert.doesNotMatch(serialized, /Do not duplicate this explanation/);
    assert.doesNotMatch(serialized, /Round-trip tests pass/);
    assert.deepEqual(
      readOrMigrateWorkContract(workspace, sessionKey),
      migrated,
      'migration is idempotent and keeps the first contract identity',
    );
  });
});

test('Work Contract revisions are optimistic and preserve contract identity', () => {
  withTempWorkspace((workspace) => {
    const sessionKey = 'session:contract-revision';
    const created = createWorkContract(workspace, {
      sessionKey,
      profileId: 'engineering',
      plan: { id: 'plan_revision', revision: 1, contentHash: PLAN_HASH },
    });
    const revised = reviseWorkContract(workspace, sessionKey, 1, (current) => ({
      ...current,
      id: 'work_attempted_replacement',
      workspaceId: 'workspace_attempted_replacement',
      status: 'approved',
      evidence: [{ id: 'evidence_build', contentHash: 'b'.repeat(64) }],
    }));

    assert.equal(revised.revision, 2);
    assert.equal(revised.id, created.id);
    assert.equal(revised.workspaceId, created.workspaceId);
    assert.equal(revised.status, 'approved');
    assert.throws(
      () => reviseWorkContract(workspace, sessionKey, 1, (current) => current),
      /revision conflict: expected 1, current 2/,
    );
    assert.deepEqual(readWorkContract(workspace, sessionKey), revised);
  });
});

test('Work Contract rejects implementation-ready tasks without lineage', () => {
  withTempWorkspace((workspace) => {
    const task: WorkTaskRef = {
      id: 'task_unlinked',
      planItemId: 'task_unlinked',
      status: 'pending',
      readiness: 'implementation_ready',
      requirementIds: [],
      acceptanceCriterionIds: [],
      decisionIds: [],
      dependencyTaskIds: [],
      affectedPaths: [],
      expectedArtifactTypes: [],
      expectedEvidenceTypes: [],
      skillIds: [],
      completionEvidenceIds: [],
    };
    assert.throws(
      () => createWorkContract(workspace, {
        sessionKey: 'session:unlinked',
        profileId: 'custom',
        plan: { id: 'plan_unlinked', revision: 1, contentHash: PLAN_HASH },
        tasks: [task],
      }),
      /cannot be implementation_ready without a requirement, criterion, or exploratory parent/,
    );
  });
});

test('Work Contract rejects absolute and escaping affected paths', () => {
  withTempWorkspace((workspace) => {
    const task: WorkTaskRef = {
      id: 'task_bad_path',
      planItemId: 'task_bad_path',
      status: 'pending',
      readiness: 'draft',
      requirementIds: [],
      acceptanceCriterionIds: [],
      decisionIds: [],
      dependencyTaskIds: [],
      affectedPaths: ['../outside.ts', '/tmp/outside.ts'],
      expectedArtifactTypes: [],
      expectedEvidenceTypes: [],
      skillIds: [],
      completionEvidenceIds: [],
    };
    assert.throws(
      () => createWorkContract(workspace, {
        sessionKey: 'session:bad-path',
        profileId: 'custom',
        plan: { id: 'plan_bad_path', revision: 1, contentHash: PLAN_HASH },
        tasks: [task],
      }),
      /must be a bounded workspace-relative path/,
    );
  });
});

test('Work Contract leaves unsupported future schemas untouched', () => {
  withTempWorkspace((workspace) => {
    const sessionKey = 'session:future-contract';
    const filePath = workContractPath(workspace, sessionKey);
    const future = JSON.stringify({ schemaVersion: 2, id: 'future_contract' });
    fs.writeFileSync(filePath, future, 'utf8');

    assert.equal(readWorkContract(workspace, sessionKey), null);
    assert.equal(fs.readFileSync(filePath, 'utf8'), future);
    assert.throws(
      () => createWorkContract(workspace, {
        sessionKey,
        profileId: 'custom',
        plan: { id: 'plan_future', revision: 1, contentHash: PLAN_HASH },
      }),
      /newer Work Contract exists/,
    );
    assert.equal(fs.readFileSync(filePath, 'utf8'), future);
  });
});

test('Steering delivery creates one pending receipt without copying an unbounded message', () => {
  withTempWorkspace((workspace) => {
    const sessionKey = 'session:steering-receipt';
    const input = {
      id: 'steer_1',
      text: `  Change   the next task. ${'detail '.repeat(80)}`,
      source: 'user' as const,
      createdAt: Date.parse('2026-07-28T01:02:03.000Z'),
    };

    const receipt = beginSteeringReceipt(workspace, sessionKey, input);
    const duplicate = beginSteeringReceipt(workspace, sessionKey, input);
    const contract = readWorkContract(workspace, sessionKey);

    assert.equal(receipt.id, input.id);
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.classification, undefined);
    assert.equal(receipt.receivedAt, '2026-07-28T01:02:03.000Z');
    assert.equal(receipt.priorRevision, 0);
    assert.ok(receipt.summary.length <= 240);
    assert.equal(duplicate.id, receipt.id);
    assert.equal(contract?.steering.length, 1);
    assert.equal(contract?.revision, 2);
    assert.equal(contract?.plan.revision, 0);
    assert.equal(contract?.tasks.length, 0);
  });
});

test('Steering reconciliation applies clarification and keeps extension input evidence-only', () => {
  withTempWorkspace((workspace) => {
    const sessionKey = 'session:steering-classification';
    beginSteeringReceipt(workspace, sessionKey, {
      id: 'steer_user',
      text: 'Clarify the output.',
      source: 'user',
      createdAt: Date.now(),
    });
    assert.deepEqual(
      pendingSteeringConstraint(workspace, sessionKey),
      { receiptId: 'steer_user', phase: 'classify' },
    );
    const clarification = reconcileSteeringReceipt(workspace, sessionKey, {
      receiptId: 'steer_user',
      classification: 'clarification',
      summary: 'Clarifies the expected output.',
    });
    assert.equal(clarification.status, 'applied');
    assert.ok(clarification.appliedAt);
    assert.equal(pendingSteeringConstraint(workspace, sessionKey), null);

    beginSteeringReceipt(workspace, sessionKey, {
      id: 'steer_extension',
      text: 'Checks failed.',
      source: 'extension',
      createdAt: Date.now(),
    });
    assert.throws(
      () => reconcileSteeringReceipt(workspace, sessionKey, {
        receiptId: 'steer_extension',
        classification: 'plan_change',
        summary: 'Change the implementation plan.',
      }),
      /evidence-only/,
    );
    const evidence = reconcileSteeringReceipt(workspace, sessionKey, {
      receiptId: 'steer_extension',
      classification: 'evidence',
      summary: 'Records a failed check.',
    });
    assert.equal(evidence.status, 'applied');
  });
});

test('Plan-changing Steer remains pending until its matching plan revision is stored', () => {
  withTempWorkspace((workspace) => {
    const sessionKey = 'session:steering-plan-change';
    const initial = updatePlan(workspace, {
      plan: [{ step: 'Implement the original behavior.', status: 'in_progress' }],
    }, sessionKey);
    beginSteeringReceipt(workspace, sessionKey, {
      id: 'steer_plan',
      text: 'Verify compatibility first.',
      source: 'user',
      createdAt: Date.now(),
    });
    const classified = reconcileSteeringReceipt(workspace, sessionKey, {
      receiptId: 'steer_plan',
      classification: 'plan_change',
      summary: 'Adds compatibility verification before implementation.',
      affectedTaskIds: [initial.items[0].id],
      affectedPhaseIds: [initial.phases![0].id],
    });
    assert.equal(classified.status, 'pending');
    assert.deepEqual(classified.affectedPhaseIds, [initial.phases![0].id]);
    assert.deepEqual(
      pendingSteeringConstraint(workspace, sessionKey),
      { receiptId: 'steer_plan', phase: 'revise_plan' },
    );

    const revisedPlan = updatePlan(workspace, {
      plan: [
        {
          id: initial.items[0].id,
          step: 'Verify compatibility before implementing the behavior.',
          status: 'in_progress',
        },
      ],
    }, sessionKey);
    const applied = applySteeringPlanRevision(
      workspace,
      sessionKey,
      'steer_plan',
      revisedPlan,
    );
    const contract = readWorkContract(workspace, sessionKey);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.resultingRevision, revisedPlan.revision);
    assert.equal(contract?.plan.revision, readPlan(workspace, sessionKey).revision);
    assert.equal(contract?.tasks[0].id, initial.items[0].id);
    assert.equal(pendingSteeringConstraint(workspace, sessionKey), null);
  });
});

test('Goal-conflicting Steer requires the user and never rewrites the goal', () => {
  withTempWorkspace((workspace) => {
    const sessionKey = 'session:steering-goal-conflict';
    beginSteeringReceipt(workspace, sessionKey, {
      id: 'steer_goal',
      text: 'Do a different project instead.',
      source: 'user',
      createdAt: Date.now(),
    });
    const receipt = reconcileSteeringReceipt(workspace, sessionKey, {
      receiptId: 'steer_goal',
      classification: 'goal_conflict',
      summary: 'Would replace the active project goal.',
    });
    assert.equal(receipt.status, 'needs_user');
    assert.equal(receipt.appliedAt, undefined);
    assert.equal(pendingSteeringConstraint(workspace, sessionKey), null);
  });
});

test('Steering tool gate permits only classification, then the matching plan revision', () => {
  assert.equal(
    evaluateSteeringToolGate(
      { receiptId: 'steer_gate', phase: 'classify' },
      'write_file',
      { path: 'src/a.ts' },
    ).allowed,
    false,
  );
  assert.equal(
    evaluateSteeringToolGate(
      { receiptId: 'steer_gate', phase: 'classify' },
      'reconcile_steer',
      { receiptId: 'steer_gate' },
    ).allowed,
    true,
  );
  assert.equal(
    evaluateSteeringToolGate(
      { receiptId: 'steer_gate', phase: 'revise_plan' },
      'update_plan',
      { steeringReceiptId: 'wrong' },
    ).allowed,
    false,
  );
  assert.equal(
    evaluateSteeringToolGate(
      { receiptId: 'steer_gate', phase: 'revise_plan' },
      'update_plan',
      { steeringReceiptId: 'steer_gate' },
    ).allowed,
    true,
  );
});
