/**
 * ADR-028 D2 — the outbox.
 *
 * Two properties carry it:
 *
 *  - Operations on ONE item never reorder. Reordering two edits to one todo
 *    produces a state neither device had — worse than either, because nobody
 *    can explain it.
 *  - Shedding is LOUD. Dropping someone's queued work quietly is the same lie
 *    B1 refuses for receipts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyOutbox, enqueue, nextBatch, acknowledge, recordFailure, stuckOperations,
  shed, replayOrder, describeSyncState,
  MAX_OUTBOX_OPERATIONS, ATTEMPTS_BEFORE_SURFACING,
  type OutboxOperation,
} from '../planner/outbox.js';

const DAY = 86_400_000;
const op = (over: Partial<OutboxOperation> & { idempotencyKey: string; itemId: string }): OutboxOperation => ({
  kind: 'update', at: { physical: 1000, logical: 0, deviceId: 'a' }, payload: {}, attempts: 0, ...over,
});

test('a duplicate idempotency key never enqueues twice', () => {
  // The key is generated with the LOCAL write, so a retry at the call site
  // cannot produce two queued operations for one user action.
  let s = enqueue(emptyOutbox(), op({ idempotencyKey: 'k1', itemId: 'i1' }));
  s = enqueue(s, op({ idempotencyKey: 'k1', itemId: 'i1' }));
  assert.equal(s.operations.length, 1);
});

test('a batch takes at most ONE operation per item', () => {
  // The ordering guarantee. A later edit must not overtake an earlier one.
  let s = emptyOutbox();
  s = enqueue(s, op({ idempotencyKey: 'k1', itemId: 'i1' }));
  s = enqueue(s, op({ idempotencyKey: 'k2', itemId: 'i1' }));
  s = enqueue(s, op({ idempotencyKey: 'k3', itemId: 'i2' }));
  const batch = nextBatch(s);
  assert.deepEqual(batch.map((o) => o.idempotencyKey), ['k1', 'k3']);
});

test('different items go in parallel — one stuck item does not block the queue', () => {
  let s = emptyOutbox();
  for (let i = 0; i < 5; i += 1) s = enqueue(s, op({ idempotencyKey: `k${i}`, itemId: `item-${i}` }));
  assert.equal(nextBatch(s).length, 5);
});

test('the batch limit is respected', () => {
  let s = emptyOutbox();
  for (let i = 0; i < 40; i += 1) s = enqueue(s, op({ idempotencyKey: `k${i}`, itemId: `item-${i}` }));
  assert.equal(nextBatch(s, 10).length, 10);
});

test('acknowledged operations leave the queue', () => {
  let s = enqueue(emptyOutbox(), op({ idempotencyKey: 'k1', itemId: 'i1' }));
  s = enqueue(s, op({ idempotencyKey: 'k2', itemId: 'i2' }));
  s = acknowledge(s, ['k1']);
  assert.deepEqual(s.operations.map((o) => o.idempotencyKey), ['k2']);
});

test('a failure is recorded WITHOUT dropping the operation', () => {
  let s = enqueue(emptyOutbox(), op({ idempotencyKey: 'k1', itemId: 'i1' }));
  s = recordFailure(s, 'k1', 'network unreachable');
  assert.equal(s.operations.length, 1);
  assert.equal(s.operations[0]!.attempts, 1);
  assert.equal(s.operations[0]!.lastError, 'network unreachable');
});

test('a permanently-failing operation becomes visible instead of retrying forever', () => {
  // A queue that never empties and never complains is indistinguishable from
  // one that is working.
  let s = enqueue(emptyOutbox(), op({ idempotencyKey: 'k1', itemId: 'i1' }));
  for (let i = 0; i < ATTEMPTS_BEFORE_SURFACING; i += 1) s = recordFailure(s, 'k1', 'boom');
  assert.equal(stuckOperations(s).length, 1);
  assert.match(describeSyncState(s), /could not be sent/);
});

test('replay orders per item by stamp, not globally', () => {
  // A global order would serialise unrelated work behind whichever item
  // happened to be stamped first.
  const ordered = replayOrder([
    op({ idempotencyKey: 'a2', itemId: 'i1', at: { physical: 200, logical: 0, deviceId: 'a' } }),
    op({ idempotencyKey: 'b1', itemId: 'i2', at: { physical: 50, logical: 0, deviceId: 'a' } }),
    op({ idempotencyKey: 'a1', itemId: 'i1', at: { physical: 100, logical: 0, deviceId: 'a' } }),
  ]);
  const i1 = ordered.filter((o) => o.itemId === 'i1').map((o) => o.idempotencyKey);
  assert.deepEqual(i1, ['a1', 'a2'], 'one item is in stamp order');
  assert.equal(ordered[0]!.itemId, 'i1', 'items keep first-seen order, not global stamp order');
});

test('nothing is shed while the queue is small and fresh', () => {
  const s = enqueue(emptyOutbox(), op({ idempotencyKey: 'k1', itemId: 'i1' }));
  const after = shed(s, 1000);
  assert.equal(after.operations.length, 1);
  assert.equal(after.shedNotice, undefined);
});

test('a device offline for months sheds — and is TOLD, with numbers', () => {
  // Silently discarding queued work is the failure this ADR is about.
  const old = op({
    idempotencyKey: 'k1', itemId: 'i1',
    at: { physical: 0, logical: 0, deviceId: 'a' },
  });
  const after = shed(enqueue(emptyOutbox(), old), 90 * DAY);
  assert.equal(after.operations.length, 0);
  assert.match(after.shedNotice!, /1 queued change/);
  assert.match(after.shedNotice!, /refreshed from the server/);
  assert.match(after.shedNotice!, /may need redoing/);
});

test('over the cap, the NEWEST operations are kept', () => {
  // The oldest are the most likely to have been superseded; the newest reflect
  // what the person currently believes.
  let s = emptyOutbox();
  for (let i = 0; i < MAX_OUTBOX_OPERATIONS + 10; i += 1) {
    s = enqueue(s, op({ idempotencyKey: `k${i}`, itemId: `i${i}`, at: { physical: 1000 + i, logical: 0, deviceId: 'a' } }));
  }
  const after = shed(s, 2000);
  assert.equal(after.operations.length, MAX_OUTBOX_OPERATIONS);
  assert.equal(after.operations.at(-1)!.idempotencyKey, `k${MAX_OUTBOX_OPERATIONS + 9}`);
  assert.match(after.shedNotice!, /beyond the 500-operation limit/);
});

test('sync state never calls offline an error', () => {
  // Offline is the normal mode that happens to be syncing, not a degradation
  // to announce.
  assert.equal(describeSyncState(emptyOutbox()), 'Everything is synced.');
  const pending = describeSyncState(enqueue(emptyOutbox(), op({ idempotencyKey: 'k', itemId: 'i' })));
  assert.match(pending, /1 change waiting to sync/);
  assert.doesNotMatch(pending, /offline|error|failed/i);
});
