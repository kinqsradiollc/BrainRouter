import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackgroundTaskService, BackgroundTaskService } from '../background/service.js';
import { listBackgroundTasks, getBackgroundTask, countActiveBackgroundTasks } from '../background/backgroundTaskStore.js';

test('BackgroundTaskService is a per-workspace facade — delegates to the store', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bgtask-svc-'));
  try {
    const svc = createBackgroundTaskService(ws);
    assert.ok(svc instanceof BackgroundTaskService);

    // fresh workspace == empty, matching the raw store
    assert.deepEqual(svc.list(), listBackgroundTasks(ws));
    assert.equal(svc.list().length, 0);

    const rec = svc.create({ kind: 'agent', title: 'analyze repo', sessionKey: 'sess-1' });
    assert.ok(rec.id.startsWith('btask_'));
    assert.equal(rec.status, 'queued');

    // service view == raw store view
    assert.deepEqual(svc.get(rec.id), getBackgroundTask(ws, rec.id));
    assert.deepEqual(svc.list(), listBackgroundTasks(ws));
    assert.equal(svc.countActive('sess-1'), countActiveBackgroundTasks(ws, 'sess-1'));

    // mutations delegate
    const running = svc.update(rec.id, { status: 'running' });
    assert.equal(running?.status, 'running');
    const withProgress = svc.appendProgress(rec.id, { phase: 'scanning', note: 'reading files' });
    assert.equal(withProgress?.progress.at(-1)?.phase, 'scanning');
    const linked = svc.linkMemory(rec.id, 'mem_123');
    assert.ok(linked?.linkedMemoryIds.includes('mem_123'));

    // filter delegation
    assert.deepEqual(svc.list({ sessionKey: 'sess-1' }), listBackgroundTasks(ws, { sessionKey: 'sess-1' }));
    assert.equal(svc.get('nope'), undefined);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
