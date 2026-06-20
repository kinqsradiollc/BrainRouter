import test from 'node:test';
import assert from 'node:assert/strict';
import { isBackgroundTaskRecord, backgroundTaskElapsedMs } from '@kinqs/brainrouter-types';
import {
  createBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
  updateBackgroundTask,
  appendTaskProgress,
  linkBackgroundTaskMemory,
  countActiveBackgroundTasks,
  currentPhase,
  reconcileBackgroundTasks,
} from '../background/backgroundTaskStore.js';
import { withTempWorkspace } from './_helpers.js';

test('backgroundTaskStore: create defaults queued, valid record, id + timestamps', () => {
  withTempWorkspace((ws) => {
    const t = createBackgroundTask(ws, { kind: 'review', title: 'Review working changes', sessionKey: 'sess:a' });
    assert.match(t.id, /^btask_[0-9a-f]{8}$/);
    assert.equal(t.status, 'queued');
    assert.equal(t.kind, 'review');
    assert.equal(t.sessionKey, 'sess:a');
    assert.equal(t.workspaceRoot, ws);
    assert.deepEqual(t.progress, []);
    assert.deepEqual(t.linkedMemoryIds, []);
    assert.equal(t.createdAt, t.updatedAt);
    assert.equal(t.startedAt, undefined);
    assert.ok(isBackgroundTaskRecord(t));
    assert.deepEqual(getBackgroundTask(ws, t.id), t);
  });
});

test('backgroundTaskStore: status transitions stamp startedAt then completedAt', () => {
  withTempWorkspace((ws) => {
    const t = createBackgroundTask(ws, { kind: 'plan-revision', title: 'Revise', sessionKey: 's', planId: 'pdec_1' });
    const running = updateBackgroundTask(ws, t.id, { status: 'running' });
    assert.equal(running?.status, 'running');
    assert.ok(running?.startedAt, 'startedAt set on running');
    assert.equal(running?.completedAt, undefined);
    const done = updateBackgroundTask(ws, t.id, { status: 'completed', result: { items: 4 } });
    assert.equal(done?.status, 'completed');
    assert.ok(done?.completedAt, 'completedAt set on terminal');
    assert.deepEqual(done?.result, { items: 4 });
    assert.equal(done?.planId, 'pdec_1');
  });
});

test('backgroundTaskStore: progress log + currentPhase + elapsed', () => {
  withTempWorkspace((ws) => {
    const t = createBackgroundTask(ws, { kind: 'review', title: 'R', sessionKey: 's', status: 'running' });
    appendTaskProgress(ws, t.id, { phase: 'collecting-diff' });
    const after = appendTaskProgress(ws, t.id, { phase: 'analyzing', note: '7 files' });
    assert.equal(after?.progress.length, 2);
    assert.equal(currentPhase(after!), 'analyzing');
    assert.equal(after?.progress[1].note, '7 files');
    // elapsed is non-negative and bounded by "now"
    const elapsed = backgroundTaskElapsedMs(after!, Date.now() + 1000);
    assert.ok(elapsed >= 0);
  });
});

test('backgroundTaskStore: memory link de-duplicates', () => {
  withTempWorkspace((ws) => {
    const t = createBackgroundTask(ws, { kind: 'review', title: 'R', sessionKey: 's' });
    linkBackgroundTaskMemory(ws, t.id, 'mem_1');
    linkBackgroundTaskMemory(ws, t.id, 'mem_1');
    const got = linkBackgroundTaskMemory(ws, t.id, 'mem_2');
    assert.deepEqual(got?.linkedMemoryIds, ['mem_1', 'mem_2']);
  });
});

test('backgroundTaskStore: list filters by session/kind/status, newest-first', () => {
  withTempWorkspace((ws) => {
    const a = createBackgroundTask(ws, { kind: 'review', title: 'A', sessionKey: 's1' });
    const b = createBackgroundTask(ws, { kind: 'plan-revision', title: 'B', sessionKey: 's1' });
    createBackgroundTask(ws, { kind: 'review', title: 'C', sessionKey: 's2' });
    updateBackgroundTask(ws, a.id, { status: 'running' });
    updateBackgroundTask(ws, b.id, { status: 'completed' });

    const s1 = listBackgroundTasks(ws, { sessionKey: 's1' });
    assert.equal(s1.length, 2);
    // newest-first: b created after a
    assert.equal(s1[0].id, b.id);

    const reviews = listBackgroundTasks(ws, { kind: 'review' });
    assert.equal(reviews.length, 2);

    const active = listBackgroundTasks(ws, { status: 'active' });
    assert.equal(active.length, 2); // a (running) + c (queued); b completed
    assert.equal(countActiveBackgroundTasks(ws), 2);
    assert.equal(countActiveBackgroundTasks(ws, 's2'), 1);
  });
});

test('backgroundTaskStore: survives reopen (durable on disk) + reconcile flips orphaned active', () => {
  withTempWorkspace((ws) => {
    const live = createBackgroundTask(ws, { kind: 'review', title: 'live', sessionKey: 's', status: 'running' });
    const done = createBackgroundTask(ws, { kind: 'review', title: 'done', sessionKey: 's', status: 'running' });
    updateBackgroundTask(ws, done.id, { status: 'completed' });

    // Re-reading the store (a fresh "process") sees the same records — durable.
    assert.equal(getBackgroundTask(ws, live.id)?.status, 'running');

    // Reconcile with an all-dead probe flips the orphaned running task to failed,
    // leaves the already-completed one alone.
    const n = reconcileBackgroundTasks(ws, () => false);
    assert.equal(n, 1);
    assert.equal(getBackgroundTask(ws, live.id)?.status, 'failed');
    assert.match(getBackgroundTask(ws, live.id)?.error ?? '', /Interrupted/);
    assert.equal(getBackgroundTask(ws, done.id)?.status, 'completed');

    // A live probe reconciles nothing.
    const again = reconcileBackgroundTasks(ws, () => true);
    assert.equal(again, 0);
  });
});
