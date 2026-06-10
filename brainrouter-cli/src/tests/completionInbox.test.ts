import test from 'node:test';
import assert from 'node:assert/strict';

import {
  enqueueCompletion,
  drainCompletions,
  peekCompletions,
  pendingCompletionCount,
  acknowledgeCompletions,
  formatCompletionFeedback,
  __resetCompletionInbox,
  type AgentCompletion,
} from '../state/completionInbox.js';

function reset() {
  __resetCompletionInbox();
}

const W = (over: Partial<AgentCompletion> = {}): AgentCompletion => ({
  kind: 'worker',
  id: 'wkr_1',
  status: 'completed',
  completedAt: '2026-06-08T00:00:00.000Z',
  ...over,
});

test('enqueue → drain round-trips and clears the queue', () => {
  reset();
  enqueueCompletion('sessA', W({ id: 'wkr_1' }));
  enqueueCompletion('sessA', W({ id: 'wkr_2' }));
  assert.equal(pendingCompletionCount('sessA'), 2);
  const drained = drainCompletions('sessA');
  assert.deepEqual(drained.map((c) => c.id), ['wkr_1', 'wkr_2']);
  // Drained → empty; a second drain yields nothing (delivered exactly once).
  assert.equal(pendingCompletionCount('sessA'), 0);
  assert.deepEqual(drainCompletions('sessA'), []);
});

test('queues are isolated per parent session', () => {
  reset();
  enqueueCompletion('sessA', W({ id: 'a1' }));
  enqueueCompletion('sessB', W({ id: 'b1' }));
  assert.deepEqual(peekCompletions('sessA').map((c) => c.id), ['a1']);
  assert.deepEqual(peekCompletions('sessB').map((c) => c.id), ['b1']);
  // Draining one leaves the other intact.
  drainCompletions('sessA');
  assert.deepEqual(peekCompletions('sessB').map((c) => c.id), ['b1']);
});

test('peek is non-destructive', () => {
  reset();
  enqueueCompletion('s', W());
  assert.equal(peekCompletions('s').length, 1);
  assert.equal(peekCompletions('s').length, 1);
});

test('a null/empty parent key is ignored (no throw, nothing queued)', () => {
  reset();
  enqueueCompletion('', W());
  enqueueCompletion(null, W());
  enqueueCompletion(undefined, W());
  assert.equal(pendingCompletionCount(''), 0);
});

test('acknowledgeCompletions drops the named ids (already delivered in-turn)', () => {
  reset();
  enqueueCompletion('s', W({ id: 'keep' }));
  enqueueCompletion('s', W({ id: 'drop' }));
  acknowledgeCompletions('s', ['drop']);
  assert.deepEqual(peekCompletions('s').map((c) => c.id), ['keep']);
  // Acking the last entry removes the whole queue.
  acknowledgeCompletions('s', ['keep']);
  assert.equal(pendingCompletionCount('s'), 0);
});

test('acknowledgeCompletions is a no-op for unknown session / empty ids', () => {
  reset();
  enqueueCompletion('s', W({ id: 'x' }));
  acknowledgeCompletions('s', []);
  acknowledgeCompletions('other', ['x']);
  assert.deepEqual(peekCompletions('s').map((c) => c.id), ['x']);
});

test('formatCompletionFeedback: empty list → empty string', () => {
  assert.equal(formatCompletionFeedback([]), '');
});

test('formatCompletionFeedback: renders kind/id/status, label, and summary', () => {
  const out = formatCompletionFeedback([
    W({ kind: 'worker', id: 'wkr_9', status: 'completed', label: 'builder', summary: 'Built the thing.' }),
    W({ kind: 'agent', id: 'agent-3', status: 'failed', summary: 'boom' }),
  ]);
  assert.match(out, /finished since your last turn/);
  assert.match(out, /✓ worker wkr_9 \(builder\) — completed/);
  assert.match(out, /Built the thing\./);
  assert.match(out, /✗ agent agent-3 — failed/);
  // Steers the model toward detail tools, away from re-spawning.
  assert.match(out, /read_worker_summary|read_agent_transcript/);
  assert.match(out, /Do NOT re-spawn/);
});

test('formatCompletionFeedback: truncates very long summaries', () => {
  const long = 'x'.repeat(2000);
  const out = formatCompletionFeedback([W({ summary: long })]);
  assert.ok(out.includes('…'), 'long summary should be truncated with an ellipsis');
  assert.ok(out.length < 1200, 'rendered feedback should be capped well under the raw length');
});
