import test from 'node:test';
import assert from 'node:assert/strict';
import {
  subscribeCompletions,
  enqueueCompletion,
  pendingCompletionCount,
  __resetCompletionInbox,
} from '../session/completion/completionInbox.js';

// WS1 — the auto-resume primitive: a host subscribes and, when a detached
// child/worker finishes for an IDLE parent session, fires a synthesis turn
// instead of waiting for the user's second prompt.

test('WS1: subscribeCompletions notifies listeners on enqueue with the parent key', () => {
  __resetCompletionInbox();
  const seen: string[] = [];
  const unsub = subscribeCompletions((k) => seen.push(k));
  enqueueCompletion('chat:parent', { kind: 'agent', id: 'a1', status: 'completed', completedAt: '2026-06-22T00:00:00Z' });
  assert.deepEqual(seen, ['chat:parent'], 'listener fired with the parent session key');
  assert.equal(pendingCompletionCount('chat:parent'), 1);
  unsub();
  enqueueCompletion('chat:parent', { kind: 'worker', id: 'w1', status: 'completed', completedAt: '2026-06-22T00:00:01Z' });
  assert.deepEqual(seen, ['chat:parent'], 'no further notification after unsubscribe');
});

test('WS1: a throwing listener never breaks enqueue', () => {
  __resetCompletionInbox();
  subscribeCompletions(() => { throw new Error('boom'); });
  assert.doesNotThrow(() =>
    enqueueCompletion('chat:p', { kind: 'agent', id: 'a', status: 'completed', completedAt: 'x' }),
  );
  assert.equal(pendingCompletionCount('chat:p'), 1, 'enqueue still recorded despite the listener throwing');
});

test('WS1: __resetCompletionInbox clears listeners too', () => {
  __resetCompletionInbox();
  const seen: string[] = [];
  subscribeCompletions((k) => seen.push(k));
  __resetCompletionInbox();
  enqueueCompletion('chat:p', { kind: 'agent', id: 'a', status: 'completed', completedAt: 'x' });
  assert.deepEqual(seen, [], 'listeners cleared by reset');
});
