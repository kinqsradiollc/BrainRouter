/**
 * ADR-040 A40-5 — session lifecycle on the reducer store.
 *
 * The behaviours here are the ones a host needs when a person forks a chat,
 * archives one, switches workspace, or drills from a stage into the child it
 * spawned. Each has a quiet failure: an archive that actually deletes, a fork
 * that mutates the history it shares, a child link that points at the wrong
 * stage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionEvent } from '@kinqs/brainrouter-agent-protocol';
import { ExecutionSessionStore } from '../orchestration/execution/reducer.js';

function event(
  executionId: string,
  sequence: number,
  payload: unknown,
  sessionKey: string,
): ExecutionEvent {
  return {
    schemaVersion: 1,
    eventId: `${executionId}-${sequence}`,
    executionId,
    executionSequence: sequence,
    sessionKey,
    emittedAt: '2026-08-15T07:00:00.000Z',
    payload,
  };
}

test('executions are indexed by their session', () => {
  const store = new ExecutionSessionStore();
  store.apply(event('e1', 1, { status: 'running' }, 'sess-A'));
  store.apply(event('e2', 1, { status: 'running' }, 'sess-A'));
  store.apply(event('e3', 1, { status: 'running' }, 'sess-B'));
  assert.deepEqual([...store.executionsForSession('sess-A')].sort(), ['e1', 'e2']);
  assert.deepEqual([...store.executionsForSession('sess-B')], ['e3']);
  assert.deepEqual([...store.executionsForSession('unknown')], []);
});

test('forgetSession drops the whole session — the transcript delete and the workspace-switch hook', () => {
  const store = new ExecutionSessionStore();
  store.apply(event('e1', 1, { status: 'succeeded' }, 'leaving'));
  store.apply(event('e2', 1, { status: 'succeeded' }, 'leaving'));
  store.apply(event('k1', 1, { status: 'running' }, 'kept'));

  const removed = store.forgetSession('leaving');
  assert.deepEqual([...removed].sort(), ['e1', 'e2']);
  assert.equal(store.snapshot('e1'), undefined);
  assert.equal(store.completenessFor('e2'), 'unavailable');
  assert.deepEqual([...store.executionsForSession('leaving')], []);
  assert.equal(store.snapshot('k1')?.status, 'running', 'the other session is untouched');
});

test('archiveSession hides from listings but keeps the record readable by id', () => {
  // The distinction from forget is the whole point: archived is retained.
  const store = new ExecutionSessionStore();
  store.apply(event('e1', 1, { status: 'succeeded' }, 'old-chat'));

  store.archiveSession('old-chat');
  assert.deepEqual([...store.executionsForSession('old-chat')], [], 'excluded from the listing');
  assert.deepEqual([...store.executionsForSession('old-chat', { includeArchived: true })], ['e1']);
  assert.equal(store.isArchived('e1'), true);
  assert.equal(store.snapshot('e1')?.status, 'succeeded', 'a direct link still resolves');
});

test('forkSession shares history by reference and does not mutate the source', () => {
  const store = new ExecutionSessionStore();
  store.apply(event('e1', 1, { status: 'succeeded' }, 'source'));
  store.apply(event('e2', 1, { status: 'succeeded' }, 'source'));

  const inherited = store.forkSession('source', 'fork');
  assert.deepEqual([...inherited].sort(), ['e1', 'e2']);
  assert.deepEqual([...store.executionsForSession('fork')].sort(), ['e1', 'e2'], 'fork sees the history');

  // New work under the fork does not appear in the source.
  store.apply(event('e3', 1, { status: 'running' }, 'fork'));
  assert.ok([...store.executionsForSession('fork')].includes('e3'));
  assert.equal([...store.executionsForSession('source')].includes('e3'), false,
    'the source must not gain the fork\'s new executions');
});

test('forking a session that does not exist inherits nothing', () => {
  const store = new ExecutionSessionStore();
  assert.deepEqual([...store.forkSession('ghost', 'fork')], []);
  assert.deepEqual([...store.executionsForSession('fork')], []);
});

test('a stage-child session is correlated back to the stage that spawned it', () => {
  const store = new ExecutionSessionStore();
  store.apply(event('parent-exec', 1, {
    nodeId: 'stage-1', attempt: 1, status: 'running', childSessionIds: ['child-sess-x'],
  }, 'parent'));
  assert.equal(store.executionForChildSession('child-sess-x'), 'parent-exec');
  assert.equal(store.executionForChildSession('never'), undefined);
});

test('child session ids union across events rather than overwriting', () => {
  const store = new ExecutionSessionStore();
  store.apply(event('p', 1, { nodeId: 'n', attempt: 1, status: 'running', childSessionIds: ['a'] }, 's'));
  store.apply(event('p', 2, { nodeId: 'n', attempt: 1, status: 'succeeded', childSessionIds: ['b'] }, 's'));
  const occ = store.snapshot('p')!.occurrences.find((o) => o.nodeId === 'n')!;
  assert.deepEqual([...occ.childSessionIds].sort(), ['a', 'b']);
  assert.equal(store.executionForChildSession('a'), 'p');
  assert.equal(store.executionForChildSession('b'), 'p');
});

test('forget cleans the session and child indexes, not just the record', () => {
  // A stale index entry would resurrect a forgotten execution in a listing or a
  // child-drill, which is worse than never having indexed it.
  const store = new ExecutionSessionStore();
  store.apply(event('e1', 1, { nodeId: 'n', attempt: 1, status: 'running', childSessionIds: ['c'] }, 'sess'));
  store.forget('e1');
  assert.deepEqual([...store.executionsForSession('sess')], []);
  assert.equal(store.executionForChildSession('c'), undefined);
});
