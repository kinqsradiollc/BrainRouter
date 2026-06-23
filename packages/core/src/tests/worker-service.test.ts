import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkerService, WorkerService } from '../worker/service.js';
import { listWorkers, readWorkerMeta, canSpawnWorker } from '../worker/workerStore.js';

test('WorkerService is a per-workspace facade — delegates to the worker store', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-svc-'));
  try {
    const svc = createWorkerService(ws);
    assert.ok(svc instanceof WorkerService);

    assert.equal(svc.canSpawn(0), canSpawnWorker(0));
    assert.deepEqual(svc.list(), listWorkers(ws));
    assert.equal(svc.list().length, 0);

    const w = svc.create({ role: 'explorer', goal: 'map the repo' });
    assert.ok(w.id);
    assert.deepEqual(svc.get(w.id), readWorkerMeta(ws, w.id));
    assert.deepEqual(svc.list(), listWorkers(ws));

    const updated = svc.update(w.id, { status: 'completed' });
    assert.equal(updated?.status, 'completed');

    svc.appendTranscript(w.id, { role: 'assistant', content: 'hi' });
    assert.equal(svc.readTranscript(w.id).length, 1);
    svc.writeSummary(w.id, '# done');
    assert.equal(svc.readSummary(w.id), '# done');

    assert.ok(svc.close(w.id));
    assert.equal(svc.get('nope'), null);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
