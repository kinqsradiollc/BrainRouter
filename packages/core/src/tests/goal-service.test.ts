import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalService, GoalService } from '../goal/service.js';
import { readGoal } from '../goal/goalStore.js';

test('GoalService is a per-workspace facade — delegates to the goal store', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-svc-'));
  const sk = 'sess-1';
  try {
    const svc = createGoalService(ws);
    assert.ok(svc instanceof GoalService);
    assert.equal(svc.read(sk), readGoal(ws, sk));
    assert.equal(svc.read(sk), null);

    const goal = svc.set('ship the service ports', sk);
    assert.equal(goal.status, 'active');
    assert.deepEqual(svc.read(sk), readGoal(ws, sk));

    assert.equal(svc.pause(sk)?.status, 'paused');
    assert.equal(svc.resume(sk)?.status, 'active');
    assert.equal(svc.setBudget(sk, 25)?.budget.maxIterations, 25);
    assert.equal(svc.edit(sk, { text: 'ship + verify the ports' })?.text, 'ship + verify the ports');
    assert.equal(typeof svc.hasBudgetLeft(svc.read(sk)!), 'boolean');
    assert.equal(typeof svc.isOnFinalBudgetTurn(svc.read(sk)!), 'boolean');

    svc.clear(sk);
    assert.equal(svc.read(sk), null);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
