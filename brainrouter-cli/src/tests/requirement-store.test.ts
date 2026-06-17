import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isRequirementRecord } from '@kinqs/brainrouter-types';
import { getCliStateFile } from '../state/cliState.js';
import {
  createRequirement,
  getRequirement,
  updateRequirement,
  listRequirements,
  linkRequirement,
  deleteRequirement,
  readRequirementsAll,
} from '../state/requirementStore.js';
import { withTempWorkspace } from './_helpers.js';

test('requirementStore: create → read back; id generated; timestamps set', () => {
  withTempWorkspace((workspace) => {
    const rec = createRequirement(workspace, { title: 'Add login', sessionKey: 'sess:a' });
    assert.match(rec.id, /^req_[0-9a-f]{8}$/);
    assert.equal(rec.title, 'Add login');
    assert.equal(rec.status, 'draft'); // default
    assert.equal(rec.priority, 'medium'); // default
    assert.deepEqual(rec.acceptanceCriteria, []);
    assert.deepEqual(rec.clarifyingQuestions, []);
    assert.equal(rec.workspaceRoot, workspace);
    assert.equal(rec.sessionKey, 'sess:a');
    assert.equal(typeof rec.createdAt, 'string');
    assert.equal(rec.createdAt, rec.updatedAt); // fresh record

    const back = getRequirement(workspace, rec.id);
    assert.deepEqual(back, rec);
  });
});

test('requirementStore: empty title is rejected', () => {
  withTempWorkspace((workspace) => {
    assert.throws(() => createRequirement(workspace, { title: '   ' }), /non-empty/);
  });
});

test('requirementStore: update status/priority/append criterion bumps updatedAt and persists', async () => {
  await new Promise<void>((resolve) => {
    withTempWorkspace((workspace) => {
      const rec = createRequirement(workspace, { title: 'Ship feature' });
      // Ensure the clock advances so updatedAt is strictly newer.
      const tick = Date.now();
      while (Date.now() === tick) { /* spin ~1ms */ }

      const updated = updateRequirement(workspace, rec.id, {
        status: 'in-progress',
        priority: 'high',
        acceptanceCriteria: [...rec.acceptanceCriteria, 'Tests pass'],
      });
      assert.ok(updated);
      assert.equal(updated.status, 'in-progress');
      assert.equal(updated.priority, 'high');
      assert.deepEqual(updated.acceptanceCriteria, ['Tests pass']);
      assert.equal(updated.createdAt, rec.createdAt); // createdAt frozen
      assert.notEqual(updated.updatedAt, rec.updatedAt); // bumped
      assert.ok(updated.updatedAt > rec.updatedAt);

      // Persisted to disk, not just returned.
      const reread = getRequirement(workspace, rec.id);
      assert.deepEqual(reread, updated);
      resolve();
    });
  });
});

test('requirementStore: update returns undefined for a missing id', () => {
  withTempWorkspace((workspace) => {
    assert.equal(updateRequirement(workspace, 'req_deadbeef', { status: 'done' }), undefined);
  });
});

test('requirementStore: id/workspaceRoot/createdAt cannot be patched', () => {
  withTempWorkspace((workspace) => {
    const rec = createRequirement(workspace, { title: 'Immutable fields' });
    // The patch type forbids id/workspaceRoot/createdAt; cast to prove the
    // runtime guard re-asserts the store-owned fields even if a caller smuggles
    // them in.
    const updated = updateRequirement(workspace, rec.id, {
      id: 'req_hacked',
      workspaceRoot: '/elsewhere',
      createdAt: '1999-01-01T00:00:00.000Z',
      status: 'ready',
    } as Parameters<typeof updateRequirement>[2]);
    assert.ok(updated);
    assert.equal(updated.id, rec.id);
    assert.equal(updated.workspaceRoot, workspace);
    assert.equal(updated.createdAt, rec.createdAt);
    assert.equal(updated.status, 'ready'); // the legit field did apply
  });
});

test('requirementStore: list filters by status and by sessionKey, newest first', () => {
  withTempWorkspace((workspace) => {
    const a = createRequirement(workspace, { title: 'A', sessionKey: 'sess:1' });
    // Advance the clock so b.createdAt is strictly newer — makes the
    // newest-first ordering assertion below deterministic.
    const tick = Date.now();
    while (Date.now() === tick) { /* spin ~1ms */ }
    const b = createRequirement(workspace, { title: 'B', sessionKey: 'sess:2' });
    updateRequirement(workspace, b.id, { status: 'done' });

    // No filter → both, newest first (b created after a).
    const all = listRequirements(workspace);
    assert.equal(all.length, 2);
    assert.equal(all[0].id, b.id);

    // Status filter.
    const done = listRequirements(workspace, { status: 'done' });
    assert.deepEqual(done.map((r) => r.id), [b.id]);
    const drafts = listRequirements(workspace, { status: 'draft' });
    assert.deepEqual(drafts.map((r) => r.id), [a.id]);

    // SessionKey filter.
    const s1 = listRequirements(workspace, { sessionKey: 'sess:1' });
    assert.deepEqual(s1.map((r) => r.id), [a.id]);

    // ANDed filters that exclude everything.
    assert.equal(listRequirements(workspace, { status: 'done', sessionKey: 'sess:1' }).length, 0);
  });
});

test('requirementStore: workspaces are isolated — two roots do not bleed', () => {
  withTempWorkspace((workspaceA) => {
    withTempWorkspace((workspaceB) => {
      const a = createRequirement(workspaceA, { title: 'Only in A' });
      const b = createRequirement(workspaceB, { title: 'Only in B' });
      assert.equal(getRequirement(workspaceA, b.id), undefined);
      assert.equal(getRequirement(workspaceB, a.id), undefined);
      assert.deepEqual(listRequirements(workspaceA).map((r) => r.title), ['Only in A']);
      assert.deepEqual(listRequirements(workspaceB).map((r) => r.title), ['Only in B']);
    });
  });
});

test('requirementStore: linkRequirement pushes unique task/artifact/memory ids (no dupes)', () => {
  withTempWorkspace((workspace) => {
    const rec = createRequirement(workspace, { title: 'Linked' });
    linkRequirement(workspace, rec.id, { taskId: 't1', artifactId: 'a1', memoryId: 'm1' });
    linkRequirement(workspace, rec.id, { taskId: 't1' }); // dup — ignored
    linkRequirement(workspace, rec.id, { taskId: 't2', memoryId: 'm1' }); // m1 dup, t2 new
    const r = getRequirement(workspace, rec.id);
    assert.ok(r);
    assert.deepEqual(r.taskIds, ['t1', 't2']);
    assert.deepEqual(r.artifactIds, ['a1']);
    assert.deepEqual(r.linkedMemoryIds, ['m1']);
  });
});

test('requirementStore: linkRequirement returns undefined for a missing id', () => {
  withTempWorkspace((workspace) => {
    assert.equal(linkRequirement(workspace, 'req_missing', { taskId: 't1' }), undefined);
  });
});

test('requirementStore: deleteRequirement removes the record and reports success', () => {
  withTempWorkspace((workspace) => {
    const rec = createRequirement(workspace, { title: 'Temp' });
    assert.equal(deleteRequirement(workspace, rec.id), true);
    assert.equal(getRequirement(workspace, rec.id), undefined);
    assert.equal(deleteRequirement(workspace, rec.id), false); // already gone
  });
});

test('requirementStore: state persists across a fresh read (simulated restart)', () => {
  withTempWorkspace((workspace) => {
    const rec = createRequirement(workspace, { title: 'Durable', priority: 'high' });
    updateRequirement(workspace, rec.id, { acceptanceCriteria: ['c1'] });

    // Confirm it landed on disk at requirements.json, then read it cold.
    const file = getCliStateFile(workspace, 'requirements.json');
    assert.equal(fs.existsSync(file), true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(onDisk[rec.id]);

    const reread = readRequirementsAll(workspace);
    assert.equal(reread[rec.id].priority, 'high');
    assert.deepEqual(reread[rec.id].acceptanceCriteria, ['c1']);
  });
});

test('isRequirementRecord: accepts a real record and rejects malformed shapes', () => {
  withTempWorkspace((workspace) => {
    const rec = createRequirement(workspace, { title: 'Guarded' });
    assert.equal(isRequirementRecord(rec), true);
  });
  // Negative controls — no workspace needed.
  assert.equal(isRequirementRecord(null), false);
  assert.equal(isRequirementRecord({}), false);
  assert.equal(
    isRequirementRecord({
      id: 'req_1',
      title: 'x',
      status: 'not-a-status', // bad enum
      priority: 'medium',
      acceptanceCriteria: [],
      clarifyingQuestions: [],
      workspaceRoot: '/w',
      taskIds: [],
      artifactIds: [],
      linkedMemoryIds: [],
      createdAt: 'now',
      updatedAt: 'now',
    }),
    false,
  );
  assert.equal(
    isRequirementRecord({
      id: 'req_1',
      title: 'x',
      status: 'draft',
      priority: 'medium',
      acceptanceCriteria: [1, 2], // not strings
      clarifyingQuestions: [],
      workspaceRoot: '/w',
      taskIds: [],
      artifactIds: [],
      linkedMemoryIds: [],
      createdAt: 'now',
      updatedAt: 'now',
    }),
    false,
  );
});
