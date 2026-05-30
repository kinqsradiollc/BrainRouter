import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  beginTurnCheckpoint, endTurnCheckpoint, queueOfflinePrompt,
  readOfflineQueue, clearOfflineQueue, readRecoverable, isConnectivityError,
} from '../state/checkpointStore.js';

function ws(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const NOW = '2026-05-31T12:00:00.000Z';

test('CLI-21 crash checkpoint: in-flight survives until cleared (simulating a crash vs clean turn)', () => {
  const { dir, cleanup } = ws();
  try {
    assert.deepEqual(readRecoverable(dir, 's:1'), { crashed: null, offline: [] });
    beginTurnCheckpoint(dir, 's:1', 'do the thing', NOW);
    // process "crashed" here → the in-flight checkpoint is still present
    const rec = readRecoverable(dir, 's:1');
    assert.equal(rec.crashed?.prompt, 'do the thing');
    assert.equal(rec.crashed?.kind, 'crash');
    // a clean turn would clear it
    endTurnCheckpoint(dir, 's:1');
    assert.equal(readRecoverable(dir, 's:1').crashed, null);
  } finally { cleanup(); }
});

test('CLI-21 offline queue: append, read, bounded, clear; scoped per session', () => {
  const { dir, cleanup } = ws();
  try {
    queueOfflinePrompt(dir, 's:1', 'first', NOW);
    queueOfflinePrompt(dir, 's:1', 'second', NOW);
    const q = readOfflineQueue(dir, 's:1');
    assert.deepEqual(q.map((x) => x.prompt), ['first', 'second']);
    assert.ok(q.every((x) => x.kind === 'offline'));
    // a different session is independent
    assert.deepEqual(readOfflineQueue(dir, 's:2'), []);
    clearOfflineQueue(dir, 's:1');
    assert.deepEqual(readOfflineQueue(dir, 's:1'), []);
  } finally { cleanup(); }
});

test('CLI-21 readRecoverable merges crash + offline', () => {
  const { dir, cleanup } = ws();
  try {
    beginTurnCheckpoint(dir, 's:1', 'inflight one', NOW);
    queueOfflinePrompt(dir, 's:1', 'queued one', NOW);
    const rec = readRecoverable(dir, 's:1');
    assert.equal(rec.crashed?.prompt, 'inflight one');
    assert.equal(rec.offline.length, 1);
    assert.equal(rec.offline[0].prompt, 'queued one');
  } finally { cleanup(); }
});

test('CLI-21 isConnectivityError: connectivity-shaped errors vs ordinary errors', () => {
  assert.equal(isConnectivityError(new Error('connect ECONNREFUSED 127.0.0.1:1234')), true);
  assert.equal(isConnectivityError(new Error('fetch failed')), true);
  assert.equal(isConnectivityError(new Error('getaddrinfo ENOTFOUND api.openai.com')), true);
  assert.equal(isConnectivityError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), true);
  assert.equal(isConnectivityError(new Error('Target content not found in file')), false);
  assert.equal(isConnectivityError(new Error('TypeError: cannot read property')), false);
});
