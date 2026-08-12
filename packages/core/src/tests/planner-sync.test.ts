/**
 * ADR-028 D11 — sync.
 *
 * D11 names three cases that destroy data if they are wrong, and each has a
 * test here: the same field edited on two devices while both were offline, an
 * item deleted on one device and edited on another, and a device returning
 * after longer than the outbox retention.
 *
 * The fourth property is the one a naive implementation gets wrong on day one:
 * a FIRST sync must never delete. An empty cache meeting a populated server is
 * a new device, not a mass deletion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  syncOnce, applyRemoteBlock, isFirstSync,
  type PlannerTransport, type PullResponse, type PushResponse,
} from '../planner/plannerSync.js';
import { describeRecordSync } from '../sync/recordSync.js';
import type { PlannerState } from '../planner/plannerStore.js';
import type { PlannerItem, Stamped } from '../planner/itemMerge.js';
import { emptyOutbox, enqueue, type OutboxOperation } from '../sync/outbox.js';

const NOW = Date.parse('2026-08-04T12:00:00.000Z');
const at = (physical: number, logical = 0, deviceId = 'a') => ({ physical, logical, deviceId });
const s = <T>(value: T, stamp = at(100)): Stamped<T> => ({ value, at: stamp });

function state(over: Partial<PlannerState> = {}): PlannerState {
  return {
    schemaVersion: 1,
    deviceId: 'a',
    clock: at(100),
    items: {},
    blocks: {},
    outbox: emptyOutbox(),
    ...over,
  };
}

function item(id: string, title: string, stamp = at(100), over: Partial<PlannerItem> = {}): PlannerItem {
  return { id, origin: 'owned', title: s(title, stamp), ...over };
}

function op(key: string, itemId: string, physical = NOW): OutboxOperation {
  return {
    idempotencyKey: key, itemId, kind: 'update',
    at: { physical, logical: 0, deviceId: 'a' }, payload: {}, attempts: 0,
  };
}

function transport(over: Partial<PlannerTransport> = {}): PlannerTransport {
  return {
    pull: async (): Promise<PullResponse> => ({ items: [], cursor: 'c1' }),
    push: async (): Promise<PushResponse> => ({ accepted: [], rejected: [] }),
    ...over,
  };
}

/**
 * Pull ONE item through the real loop.
 *
 * These assertions used to call `applyRemoteItem`, which had no caller outside
 * this file and was retired 2026-08-12 — so every merge rule below was proven
 * against a function the pull path did not use, and the one behaviour that
 * differed (the tombstone cascade) was silently absent in the product. Driving
 * `syncOnce` costs a transport stub and tests the path that runs.
 */
async function pull(local: PlannerState, remote: PlannerItem): Promise<{ conflicted: boolean }> {
  const r = await syncOnce(local, transport({
    pull: async () => ({ items: [remote], cursor: 'c1' }),
  }), NOW);
  return { conflicted: r.conflicted.includes(remote.id) };
}

/* ---------------------------------------------------------- the first sync */

test('a FIRST sync accepts everything and deletes nothing', () => {
  // An empty cache meeting a populated server is a new device. Diffing naively
  // here reads as "everything was deleted", and that is the catastrophe.
  const local = state();
  assert.equal(isFirstSync(local), true);
  return syncOnce(local, transport({
    pull: async () => ({ items: [item('i1', 'from server'), item('i2', 'also')], cursor: 'c1' }),
  }), NOW).then((r) => {
    assert.equal(r.pulled, 2);
    assert.equal(Object.keys(local.items).length, 2);
    assert.equal(isFirstSync(local), false, 'the cursor is recorded');
  });
});

test('an empty server does NOT clear a populated device', async () => {
  // The reverse case: a fresh account, not a signal to wipe local work.
  const local = state({ items: { i1: item('i1', 'mine') } });
  await syncOnce(local, transport(), NOW);
  assert.equal(Object.keys(local.items).length, 1);
  assert.equal(local.items.i1!.title.value, 'mine');
});

/* ------------------------------------------------------- the ordering rule */

test('pull happens BEFORE push', async () => {
  // Pushing first lets a device that has been offline a week clobber a week of
  // other devices' work simply by speaking last.
  const order: string[] = [];
  const local = state({ outbox: enqueue(emptyOutbox(), op('k1', 'i1')) });
  await syncOnce(local, {
    pull: async () => { order.push('pull'); return { items: [], cursor: 'c1' }; },
    push: async () => { order.push('push'); return { accepted: ['k1'], rejected: [] }; },
  }, NOW);
  assert.deepEqual(order, ['pull', 'push']);
});

test('a failed pull leaves the outbox untouched and reports offline, not error', async () => {
  const local = state({ outbox: enqueue(emptyOutbox(), op('k1', 'i1')) });
  const r = await syncOnce(local, transport({
    pull: async () => { throw new Error('ENOTFOUND'); },
  }), NOW);
  assert.equal(r.offline, true);
  assert.equal(local.outbox.operations.length, 1, 'nothing was lost');
});

test('a failed push KEEPS the successful pull', async () => {
  // Undoing the pull because the push failed would throw away work that
  // genuinely arrived.
  const local = state({ outbox: enqueue(emptyOutbox(), op('k1', 'i1')) });
  const r = await syncOnce(local, {
    pull: async () => ({ items: [item('i9', 'arrived')], cursor: 'c2' }),
    push: async () => { throw new Error('502'); },
  }, NOW);
  assert.equal(r.offline, true);
  assert.equal(local.items.i9?.title.value, 'arrived');
  assert.equal(local.lastPulledAt, 'c2');
  assert.equal(local.outbox.operations[0]!.attempts, 1, 'the attempt is counted');
});

test('a REJECTED operation is kept with its reason, never dropped', async () => {
  // A silently discarded operation is work the person did that nobody will
  // ever tell them was lost.
  const local = state({ outbox: enqueue(emptyOutbox(), op('k1', 'i1')) });
  const r = await syncOnce(local, transport({
    push: async () => ({ accepted: [], rejected: [{ idempotencyKey: 'k1', reason: 'stale revision' }] }),
  }), NOW);
  assert.equal(local.outbox.operations.length, 1);
  assert.equal(local.outbox.operations[0]!.lastError, 'stale revision');
  assert.deepEqual(r.rejected, [{ idempotencyKey: 'k1', reason: 'stale revision' }]);
});

test('accepted operations leave the outbox', async () => {
  const local = state({ outbox: enqueue(emptyOutbox(), op('k1', 'i1')) });
  const r = await syncOnce(local, transport({
    push: async () => ({ accepted: ['k1'], rejected: [] }),
  }), NOW);
  assert.equal(local.outbox.operations.length, 0);
  assert.equal(r.pushed, 1);
});

test('a partial, duplicate or extraneous acknowledgement never removes queued work', async () => {
  for (const response of [
    { accepted: [], rejected: [] },
    { accepted: ['k1', 'k1'], rejected: [] },
    { accepted: ['not-sent'], rejected: [{ idempotencyKey: 'k1', reason: 'no' }] },
  ] satisfies PushResponse[]) {
    const local = state({ outbox: enqueue(emptyOutbox(), op('k1', 'i1')) });
    const result = await syncOnce(local, transport({ push: async () => response }), NOW);
    assert.equal(local.outbox.operations.length, 1);
    assert.match(local.outbox.operations[0]!.lastError ?? '', /acknowledg/);
    assert.equal(result.pushed, 0);
  }
});

test('pulled time blocks land as blocks and never pass through item merge', async () => {
  const local = state();
  const result = await syncOnce(local, transport({
    pull: async () => ({
      items: [], cursor: 'c1',
      blocks: [{
        id: 'block-1', itemId: 'item-1', estimateMinutes: 45, carriedOver: 0,
        scheduledFor: '2026-08-04T09:00:00.000Z', updatedAt: at(500, 0, 'server'),
      }],
    }),
  }), NOW);
  assert.equal(result.pulledBlocks, 1);
  assert.equal(local.blocks['block-1']?.estimateMinutes, 45);
  assert.equal(local.items['block-1'], undefined);
});

test('a pulled stale block cannot overwrite a newer queued local move', () => {
  const move = {
    ...op('block:move', 'block-1', 2_000),
    entity: 'block' as const,
    payload: { scheduledFor: '2026-08-05T10:00:00.000Z' },
  };
  const local = state({
    blocks: {
      'block-1': {
        id: 'block-1', itemId: 'item-1', estimateMinutes: 30, carriedOver: 0,
        scheduledFor: '2026-08-05T10:00:00.000Z', updatedAt: at(2_000),
      },
    },
    outbox: enqueue(emptyOutbox(), move),
  });
  const applied = applyRemoteBlock(local, {
    id: 'block-1', itemId: 'item-1', estimateMinutes: 30, carriedOver: 0,
    scheduledFor: '2026-08-04T09:00:00.000Z', updatedAt: at(1_000, 0, 'server'),
  });
  assert.equal(applied, false);
  assert.equal(local.blocks['block-1']?.scheduledFor, '2026-08-05T10:00:00.000Z');
});

test('a pulled item tombstone cascades to and hides its local time blocks', async () => {
  const local = state({
    items: { i1: item('i1', 'parent', at(100)) },
    blocks: {
      b1: {
        id: 'b1', itemId: 'i1', estimateMinutes: 30, carriedOver: 0,
        updatedAt: at(150, 0, 'a'),
      },
    },
  });
  const deletedAt = at(500, 0, 'server');
  await pull(local, item('i1', 'parent', at(100), { deletedAt }));
  assert.deepEqual(local.blocks.b1?.deletedAt, deletedAt);
  assert.deepEqual(local.blocks.b1?.updatedAt, deletedAt);
});

test('a fresh device persists a pulled block tombstone', () => {
  const local = state();
  const deletedAt = at(500, 0, 'server');
  assert.equal(applyRemoteBlock(local, {
    id: 'b1', itemId: 'i1', estimateMinutes: 30, carriedOver: 0,
    updatedAt: deletedAt, deletedAt,
  }), true);
  assert.deepEqual(local.blocks.b1?.deletedAt, deletedAt);
});

/* ------------------------------------------- D11's three destructive cases */

test('CASE 1 — the same field edited on two offline devices conflicts, keeping both', async () => {
  const local = state({ items: { i1: item('i1', 'our version', at(300, 1, 'a')) } });
  const { conflicted } = await pull(local, item('i1', 'their version', at(300, 1, 'b')));
  assert.equal(conflicted, true);
  assert.ok(local.items.i1!.conflicts?.title, 'both versions survive for a human to pick');
});

test('CASE 2 — deleted here, edited there: resurrects as conflicted', async () => {
  // Neither silently undeleting nor silently discarding the edit is acceptable.
  const local = state({
    items: { i1: { ...item('i1', 'draft', at(100)), deletedAt: at(200, 0, 'a') } },
  });
  await pull(local, item('i1', 'draft, revised', at(400, 0, 'b')));
  assert.equal(local.items.i1!.deletedAt, undefined);
  assert.equal(local.items.i1!.conflicts?.deleted?.reason, 'delete_vs_edit');
  assert.equal(local.items.i1!.title.value, 'draft, revised', 'the edit is not lost');
});

test('CASE 3 — a device back after months sheds and is TOLD, before syncing', async () => {
  const ancient = op('old', 'i1', 0);
  const local = state({ outbox: enqueue(emptyOutbox(), ancient) });
  const r = await syncOnce(local, transport(), 120 * 86_400_000);
  assert.equal(local.outbox.operations.length, 0);
  assert.match(r.shedNotice!, /could not be sent/);
  assert.match(r.shedNotice!, /may need redoing/);
});

/* ------------------------------------------------------------- item merges */

test('a mirrored item is RE-READ, not merged — the source owns its truth', async () => {
  const local = state({
    items: {
      'gh:1': {
        id: 'gh:1', origin: 'mirrored', source: 'github',
        title: s('stale local edit', at(900, 0, 'a')),
        priority: s(3, at(800, 0, 'a')),
      },
    },
  });
  await pull(local, {
    id: 'gh:1', origin: 'mirrored', source: 'github', title: s('real title', at(1, 0, 'srv')),
  });
  assert.equal(local.items['gh:1']!.title.value, 'real title', 'an older remote stamp still wins');
  assert.equal(local.items['gh:1']!.priority?.value, 3, 'planner metadata survives');
});

test('an unseen remote item is added, not treated as a conflict', async () => {
  const local = state();
  const { conflicted } = await pull(local, item('new', 'hello'));
  assert.equal(conflicted, false);
  assert.equal(local.items.new?.title.value, 'hello');
});

test('the server clock is absorbed, so a slow device stops losing every tie', async () => {
  const local = state({ clock: at(100, 0, 'a') });
  await syncOnce(local, transport({
    pull: async () => ({ items: [], cursor: 'c1', serverClock: at(500_000, 0, 'srv') }),
  }), NOW);
  assert.ok(local.clock.physical >= 500_000);
  assert.equal(local.clock.deviceId, 'a', 'it is still OUR clock');
});

test('a server clock far ahead is REPORTED, not silently absorbed', async () => {
  // ADR-028 D3 says the skew is reported. `clockSkewMs` and `describeSkew`
  // wrote that sentence and had no caller until 2026-08-12, so a device an hour
  // behind absorbed the jump and said nothing while every pulled stamp read as
  // the future. Measured BEFORE `hlcReceive`, which is the only moment the two
  // clocks are still distinguishable.
  const local = state({ clock: at(NOW, 0, 'a') });
  const r = await syncOnce(local, transport({
    pull: async () => ({ items: [], cursor: 'c1', serverClock: at(NOW + 42 * 60_000, 0, 'srv') }),
  }), NOW);
  assert.match(r.clockNotice!, /about 42 minutes ahead/);
  assert.match(describeRecordSync(r, local.outbox), /about 42 minutes ahead/);
});

test('ordinary drift is not worth a sentence', async () => {
  // Below the notable threshold every device would report every sync, and a
  // line that always appears is one nobody reads on the day it matters.
  const local = state({ clock: at(NOW, 0, 'a') });
  const r = await syncOnce(local, transport({
    pull: async () => ({ items: [], cursor: 'c1', serverClock: at(NOW + 30_000, 0, 'srv') }),
  }), NOW);
  assert.equal(r.clockNotice, undefined);
  assert.equal(describeRecordSync(r, local.outbox), 'Everything is synced.');
});

test('future item and block stamps are absorbed even when the server wall clock is behind', async () => {
  const future = NOW + 600_000;
  const local = state({ clock: at(100, 0, 'a') });
  await syncOnce(local, transport({
    pull: async () => ({
      items: [item('fast', 'from fast peer', at(future, 4, 'fast-peer'))],
      blocks: [{
        id: 'fast-block', itemId: 'fast', estimateMinutes: 30, carriedOver: 0,
        updatedAt: at(future + 1, 2, 'fast-peer'),
      }],
      cursor: 'c1',
      serverClock: at(NOW, 0, 'server'),
    }),
  }), NOW);
  assert.equal(local.clock.physical, future + 1);
  assert.ok(local.clock.logical > 2);
  assert.equal(local.clock.deviceId, 'a');
});

/* ------------------------------------------------------------- the message */

test('conflicts are reported FIRST — they are the only thing that cannot self-resolve', () => {
  const text = describeRecordSync(
    { pulled: 1, pushed: 0, rejected: [], conflicted: ['i1'], offline: false },
    emptyOutbox(),
  );
  assert.match(text, /changed in two places/);
  assert.match(text, /pick which version/);
});

test('offline is reported last and never as a failure', () => {
  const text = describeRecordSync(
    { pulled: 0, pushed: 0, rejected: [], conflicted: [], offline: true },
    enqueue(emptyOutbox(), op('k', 'i')),
  );
  assert.match(text, /1 change waiting to sync/);
  assert.doesNotMatch(text, /error|failed/i);
});

test('a clean sync says so plainly', () => {
  assert.equal(
    describeRecordSync({ pulled: 0, pushed: 0, rejected: [], conflicted: [], offline: false }, emptyOutbox()),
    'Everything is synced.',
  );
});

test('a wedged change outranks a skewed clock, because only one of them is a loss', () => {
  // Regression. `clockNotice` shipped ABOVE the stuck branch for one commit, so a
  // laptop back from sleep — five minutes of skew, entirely ordinary — replaced
  // "could not be sent" with a sentence about time, and went on replacing it for
  // as long as the clock was wrong. The surface has one line; it must spend it on
  // the thing a person can act on.
  const wedged = [...Array(7)].reduce(
    (state) => ({ ...state, operations: state.operations.map((op: OutboxOperation) => ({ ...op, attempts: (op.attempts ?? 0) + 1, lastError: 'HTTP 500' })) }),
    enqueue(emptyOutbox(), { idempotencyKey: 'k1', itemId: 'i1', kind: 'update', at: { physical: 1, logical: 0, deviceId: 'd' } } as OutboxOperation),
  );
  const skewed = { pulled: 0, pushed: 0, conflicted: [], offline: false, clockNotice: 'Another device clock is about 42 minutes ahead.' };

  assert.match(describeRecordSync(skewed as never, wedged), /could not be sent/);

  // And the notice is not lost — it is what shows once nothing is wedged.
  assert.match(describeRecordSync(skewed as never, emptyOutbox()), /clock is about 42 minutes ahead/);
});
