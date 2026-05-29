import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_WORKER_DEPTH,
  canSpawnWorker,
  createWorker,
  readWorkerMeta,
  updateWorkerMeta,
  listWorkers,
  writeWorkerSummary,
  readWorkerSummary,
  closeWorker,
  workerDir,
} from '../state/workerStore.js';

function ws(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'br-workers-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('MAS-P5-T3 canSpawnWorker: workers cannot spawn workers (MAX_WORKER_DEPTH=1)', () => {
  assert.equal(MAX_WORKER_DEPTH, 1);
  assert.equal(canSpawnWorker(0), true);
  assert.equal(canSpawnWorker(1), false);
});

test('MAS-P5-T3 createWorker → readWorkerMeta round-trip; writes goal.json', () => {
  const { dir, cleanup } = ws();
  try {
    const w = createWorker(dir, {
      role: 'worker',
      goal: 'migrate the auth module',
      ownership: 'src/auth/**',
      depth: 0,
      parentSessionKey: 'parent',
      pid: 4242,
      id: 'wkr_test',
      now: '2026-05-29T00:00:00.000Z',
    });
    assert.equal(w.status, 'running');
    assert.equal(w.ownership, 'src/auth/**');
    const read = readWorkerMeta(dir, 'wkr_test');
    assert.deepEqual(read, w);
    // goal.json written
    const goal = JSON.parse(readFileSync(join(workerDir(dir, 'wkr_test'), 'goal.json'), 'utf-8'));
    assert.equal(goal.text, 'migrate the auth module');
  } finally {
    cleanup();
  }
});

test('MAS-P5-T3 updateWorkerMeta: patches status, preserves id/createdAt, bumps updatedAt', () => {
  const { dir, cleanup } = ws();
  try {
    createWorker(dir, { role: 'worker', goal: 'x', id: 'w1', now: '2026-05-29T00:00:00.000Z' });
    const updated = updateWorkerMeta(dir, 'w1', { status: 'completed', pid: null }, '2026-05-29T01:00:00.000Z');
    assert.equal(updated?.status, 'completed');
    assert.equal(updated?.createdAt, '2026-05-29T00:00:00.000Z');
    assert.equal(updated?.updatedAt, '2026-05-29T01:00:00.000Z');
    assert.equal(updateWorkerMeta(dir, 'missing', { status: 'failed' }), null);
  } finally {
    cleanup();
  }
});

test('MAS-P5-T3 listWorkers (newest first) + summary round-trip + closeWorker', () => {
  const { dir, cleanup } = ws();
  try {
    createWorker(dir, { role: 'a', goal: 'first', id: 'w1', now: '2026-05-29T00:00:01.000Z' });
    createWorker(dir, { role: 'b', goal: 'second', id: 'w2', now: '2026-05-29T00:00:02.000Z' });
    const list = listWorkers(dir);
    assert.deepEqual(list.map((w) => w.id), ['w2', 'w1']); // newest first

    writeWorkerSummary(dir, 'w1', '# Progress\nDid the thing.');
    assert.match(readWorkerSummary(dir, 'w1') ?? '', /Did the thing/);
    assert.equal(readWorkerSummary(dir, 'missing'), null);

    const closed = closeWorker(dir, 'w1');
    assert.equal(closed?.status, 'closed');
  } finally {
    cleanup();
  }
});

test('MAS-P5-T3 listWorkers is empty (not error) when no workers dir', () => {
  const { dir, cleanup } = ws();
  try {
    assert.deepEqual(listWorkers(dir), []);
    assert.equal(existsSync(workerDir(dir, 'nope')), false);
  } finally {
    cleanup();
  }
});
