import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrchestrationService, OrchestrationService } from '../orchestration/session/service.js';
import { listSessions, getSession, formatSessionSummary } from '../orchestration/session/orchestrator.js';

test('OrchestrationService is a per-workspace facade — delegates to the session store', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-svc-'));
  try {
    const svc = createOrchestrationService(ws);
    assert.ok(svc instanceof OrchestrationService);

    assert.deepEqual(svc.list(), listSessions(ws));
    assert.equal(svc.list().length, 0);

    const child = svc.create({ role: 'explorer', prompt: 'map the repo', parentSessionKey: 'chat-1' });
    assert.ok(child.id);
    assert.deepEqual(svc.get(child.id), getSession(ws, child.id));
    assert.deepEqual(svc.list(), listSessions(ws));

    const completed = { ...svc.update(child.id, { status: 'completed', completedAt: new Date().toISOString() }) };
    assert.equal(completed.status, 'completed');
    // formatSummary is the one pure helper on the contract — must match the module 1:1.
    assert.equal(svc.formatSummary(completed), formatSessionSummary(completed));

    // No worktree-patches dir + same pid → both prune and reconcile are no-ops here.
    assert.equal(svc.pruneWorktreePatches(0), 0);
    assert.equal(svc.pruneWorktreePatches(), 0);
    assert.equal(svc.reconcileStale(), 0);

    assert.equal(svc.get('nope'), undefined);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
