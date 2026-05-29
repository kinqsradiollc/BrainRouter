import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorker,
  updateWorkerMeta,
  appendWorkerTranscript,
  readWorkerTranscript,
  staleWorkerIds,
  reconcileStaleWorkers,
  readWorkerMeta,
  type WorkerMeta,
} from '../state/workerStore.js';

function ws(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'br-worker-rt-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const w = (over: Partial<WorkerMeta>): WorkerMeta => ({
  id: 'w',
  status: 'running',
  role: 'worker',
  goal: 'g',
  ownership: null,
  depth: 0,
  parentSessionKey: null,
  pid: 4242,
  createdAt: '2026-05-29T00:00:00.000Z',
  updatedAt: '2026-05-29T00:00:00.000Z',
  ...over,
});

test('MAS-P5-T3 staleWorkerIds: running + dead pid only', () => {
  const isAlive = (pid: number | null) => pid === 4242;
  const ids = staleWorkerIds(
    [
      w({ id: 'alive', pid: 4242, status: 'running' }), // running, alive → not stale
      w({ id: 'dead', pid: 9, status: 'running' }), // running, dead → stale
      w({ id: 'nopid', pid: null, status: 'running' }), // running, null pid → stale
      w({ id: 'done', pid: 9, status: 'completed' }), // terminal → never stale
    ],
    isAlive,
  );
  assert.deepEqual(ids.sort(), ['dead', 'nopid']);
});

test('MAS-P5-T3 reconcileStaleWorkers: flips dead-pid running workers to failed', () => {
  const { dir, cleanup } = ws();
  try {
    createWorker(dir, { role: 'a', goal: 'orphan', id: 'orphan', pid: 999999 }); // not this process
    createWorker(dir, { role: 'b', goal: 'mine', id: 'mine', pid: process.pid }); // this process
    updateWorkerMeta(dir, 'done', {}); // no-op (missing) — safe

    const n = reconcileStaleWorkers(dir);
    assert.equal(n, 1);
    assert.equal(readWorkerMeta(dir, 'orphan')?.status, 'failed');
    assert.equal(readWorkerMeta(dir, 'mine')?.status, 'running'); // current process untouched
  } finally {
    cleanup();
  }
});

test('MAS-P5-T3 readWorkerTranscript: returns last-N parsed entries, tolerant of bad lines', () => {
  const { dir, cleanup } = ws();
  try {
    createWorker(dir, { role: 'a', goal: 'g', id: 'w1' });
    appendWorkerTranscript(dir, 'w1', { role: 'system', event: 'spawn' });
    appendWorkerTranscript(dir, 'w1', { role: 'tool', event: 'start', tool: 'read_file' });
    appendWorkerTranscript(dir, 'w1', { role: 'assistant', content: 'done' });
    const entries = readWorkerTranscript(dir, 'w1', 2) as Array<Record<string, unknown>>;
    assert.equal(entries.length, 2); // last 2
    assert.equal(entries[1].content, 'done');
    // missing worker → empty, not throw
    assert.deepEqual(readWorkerTranscript(dir, 'missing'), []);
  } finally {
    cleanup();
  }
});
