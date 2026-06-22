import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskService, TaskService } from '../task/service.js';
import { readPlan } from '../task/taskStore.js';

test('TaskService is a per-workspace facade — delegates to the plan store', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'task-svc-'));
  const sk = 'sess-1';
  try {
    const svc = createTaskService(ws);
    assert.ok(svc instanceof TaskService);
    assert.deepEqual(svc.read(sk), readPlan(ws, sk));

    const state = svc.update({ explanation: 'two steps', plan: [
      { step: 'write the port', status: 'completed' },
      { step: 'write the test', status: 'in_progress' },
    ] }, sk);
    assert.equal(state.items.length, 2);
    assert.deepEqual(svc.read(sk), readPlan(ws, sk));

    const rendered = svc.format(state);
    assert.equal(typeof rendered, 'string');
    assert.ok(rendered.includes('write the port'));

    const seeded = svc.seedFromRequirement({ id: 'req_1', acceptanceCriteria: ['it builds', 'tests pass'] }, 'sess-2');
    assert.ok(seeded.items.length >= 1);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
