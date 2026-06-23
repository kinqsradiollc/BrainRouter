import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorageService, StorageService } from '../storage/service.js';
import { readRecoverable, readOfflineQueue } from '../storage/checkpointStore.js';
import { readFileMutations, planRestore, type FileMutationRecord } from '../storage/fileSnapshotStore.js';

test('StorageService is a per-workspace facade — delegates to the checkpoint + snapshot stores', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-svc-'));
  const sk = 'sess-1';
  try {
    const svc = createStorageService(ws);
    assert.ok(svc instanceof StorageService);
    assert.deepEqual(svc.readRecoverable(sk), readRecoverable(ws, sk));

    svc.beginTurn(sk, 'do the thing', '2020-01-01T00:00:00.000Z');
    assert.deepEqual(svc.readRecoverable(sk), readRecoverable(ws, sk));
    svc.endTurn(sk);

    svc.queueOffline(sk, 'queued prompt', '2020-01-01T00:00:01.000Z');
    assert.equal(svc.readOfflineQueue(sk).length, 1);
    assert.deepEqual(svc.readOfflineQueue(sk), readOfflineQueue(ws, sk));
    svc.clearOfflineQueue(sk);
    assert.equal(svc.readOfflineQueue(sk).length, 0);

    const rec: FileMutationRecord = { turn: 1, path: 'src/x.ts', priorContent: null };
    svc.recordFileMutation(sk, rec);
    assert.equal(svc.readFileMutations(sk).length, 1);
    assert.deepEqual(svc.readFileMutations(sk), readFileMutations(ws, sk));
    assert.deepEqual(svc.planRestore(svc.readFileMutations(sk), 1), planRestore(readFileMutations(ws, sk), 1));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
