/**
 * Work Contract v1 round-trip, migration, and invariant proofs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { updatePlan } from '../task/taskStore.js';
import {
  createWorkContract,
  readOrMigrateWorkContract,
  readWorkContract,
  reviseWorkContract,
  workContractPath,
} from '../task/workContractStore.js';
import type { WorkTaskRef } from '../task/workContract.js';
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
