import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequirementService, RequirementService } from '../requirement/records/service.js';
import { readRequirementsAll, getRequirement, listRequirements } from '../requirement/records/requirementStore.js';

test('RequirementService is a per-workspace facade — delegates to the requirement store', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'req-svc-'));
  try {
    const svc = createRequirementService(ws);
    assert.ok(svc instanceof RequirementService);
    assert.deepEqual(svc.readAll(), readRequirementsAll(ws));
    assert.equal(svc.list().length, 0);

    const r = svc.create({ title: 'Add Postgres backend' });
    assert.ok(r.id.startsWith('req_'));
    assert.deepEqual(svc.get(r.id), getRequirement(ws, r.id));
    assert.deepEqual(svc.list(), listRequirements(ws));

    assert.equal(svc.update(r.id, { priority: 'high' })?.priority, 'high');
    assert.equal(svc.link(r.id, { taskId: 'task-1' })?.taskIds.includes('task-1'), true);

    // Clarifying-question lifecycle: ask → open → answer → resolved.
    const asked = svc.addQuestion(r.id, 'Which Postgres version?');
    assert.equal(asked?.status, 'clarifying');
    assert.equal(svc.openQuestions(asked!).length, 1);
    const answered = svc.answerQuestion(r.id, 0, 'pg16');
    assert.equal(svc.openQuestions(answered!).length, 0);
    assert.equal(svc.setQuestions(r.id, [])?.clarifyingQuestions.length, 0);

    assert.equal(svc.delete(r.id), true);
    assert.equal(svc.get(r.id), undefined);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
