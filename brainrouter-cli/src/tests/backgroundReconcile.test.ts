import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileStaleBackgroundTasks } from '../runtime/backgroundReconcile.js';
import { createWorker, readWorkerMeta } from '../state/workerStore.js';
import { withTempWorkspaceAsync } from './_helpers.js';

test('DESK-5w reconcile flips a DEAD-pid worker to failed, leaves a LIVE-pid worker running', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    // A worker left over from a now-closed app (its owning pid is gone)...
    const dead = createWorker(ws, { role: 'worker', goal: 'run the suite', pid: 999_999 });
    // ...and one owned by a still-alive process (e.g. a CLI running alongside).
    const live = createWorker(ws, { role: 'worker', goal: 'index the repo', pid: process.pid });

    // Mirror the host's real-pid liveness without depending on OS pid 999999.
    const isAlive = (pid: number | null | undefined) => pid === process.pid;
    const r = reconcileStaleBackgroundTasks(ws, isAlive);

    assert.equal(r.workers, 1, 'exactly the dead-owner worker was reconciled');
    assert.equal(readWorkerMeta(ws, dead.id)?.status, 'failed', 'phantom "running" worker flipped to failed on boot');
    assert.equal(readWorkerMeta(ws, live.id)?.status, 'running', 'a genuinely-alive worker is left alone');
  });
});

test('DESK-5w reconcile is a no-op when there is nothing stale', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    createWorker(ws, { role: 'worker', goal: 'g', pid: process.pid });
    const r = reconcileStaleBackgroundTasks(ws, () => true /* everything alive */);
    assert.deepEqual(r, { sessions: 0, workers: 0, runs: 0 });
  });
});
