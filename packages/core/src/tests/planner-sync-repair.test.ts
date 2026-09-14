/**
 * ADR-038 D4 — a block the server refuses because its parent item is missing
 * is repaired, not retried forever.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hlcZero } from '../sync/hybridClock.js';
import { syncOnce, type PlannerTransport } from '../planner/plannerSync.js';
import type { PlannerState } from '../planner/plannerStore.js';
import type { OutboxOperation } from '../sync/outbox.js';

const NOW = Date.parse('2026-09-14T06:40:00.000Z');

function state(): PlannerState {
  const at = { physical: NOW - 60_000, logical: 0, deviceId: 'dev' };
  const item = { id: 'itm_parent', origin: 'owned' as const, title: { value: 'Focus block', at }, createdAt: at, updatedAt: at };
  const block = { id: 'blk_1', itemId: 'itm_parent', estimateMinutes: 60, carriedOver: 0, updatedAt: at };
  const op = (key: string, entity: 'item' | 'block', itemId: string, kind: OutboxOperation['kind'], payload: Record<string, unknown>): OutboxOperation =>
    ({ idempotencyKey: key, entity, itemId, kind, at, payload, attempts: 0 } as OutboxOperation);
  return {
    schemaVersion: 1,
    deviceId: 'dev',
    clock: hlcZero('dev'),
    items: { itm_parent: item as unknown as PlannerState['items'][string] },
    blocks: { blk_1: block as unknown as PlannerState['blocks'][string] },
    outbox: { operations: [
      op('k-move-1', 'block', 'blk_1', 'update', { scheduledFor: '2026-09-15T00:00:00.000Z' }),
      op('k-move-2', 'block', 'blk_1', 'update', { scheduledFor: '2026-09-15T01:00:00.000Z' }),
      op('k-orphan', 'block', 'blk_gone', 'update', { scheduledFor: '2026-09-16T00:00:00.000Z' }),
    ] },
  };
}

function transport(reject: Record<string, string>): PlannerTransport & { pushes: OutboxOperation[][] } {
  const pushes: OutboxOperation[][] = [];
  return {
    pushes,
    pull: async () => ({ items: [], cursor: 'c1', blocks: [] }),
    push: async (ops) => {
      pushes.push([...ops]);
      const accepted = ops.filter((o) => !reject[o.idempotencyKey]).map((o) => o.idempotencyKey);
      const rejected = ops.filter((o) => reject[o.idempotencyKey]).map((o) => ({ idempotencyKey: o.idempotencyKey, reason: reject[o.idempotencyKey]! }));
      return { accepted, rejected };
    },
  };
}

test('a block rejected for a missing parent that exists locally gets the parent re-sent, ahead of it, with a notice', async () => {
  const s = state();
  const t = transport({ 'k-move-1': 'The parent planner item itm_parent does not exist.' });
  const result = await syncOnce(s, t, NOW);
  assert.deepEqual(result.rejected.map((r) => r.idempotencyKey), ['k-move-1']);
  assert.match(result.repairNotice ?? '', /Re-sending an item the server had not received \(Focus block\)/);
  const first = s.outbox.operations[0]!;
  assert.equal(first.entity, 'item');
  assert.equal(first.kind, 'create');
  assert.equal(first.itemId, 'itm_parent');
  assert.equal((first.payload as { id?: string }).id, 'itm_parent', 'the create carries the local item');
  assert.ok(s.outbox.operations.some((o) => o.idempotencyKey === 'k-move-1'), 'the rejected block change is kept, behind the create');
  assert.equal(s.outbox.operations.find((o) => o.idempotencyKey === 'k-move-1')?.attempts, 1);
  // The next cycle sends the create in the same batch as the block's first change (one op per record), create first.
  // (`k-orphan` was accepted in the first cycle and is gone.)
  const next = transport({});
  await syncOnce(s, next, NOW + 1_000);
  assert.deepEqual(next.pushes[0]!.map((o) => `${o.entity}:${o.kind}:${o.itemId}`), ['item:create:itm_parent', 'block:update:blk_1']);
  // A second rejection for the same parent does not queue a second create.
  const again = state();
  again.outbox = { operations: [{ ...again.outbox.operations[0]!, idempotencyKey: 'k-move-0' }, ...again.outbox.operations] };
  await syncOnce(again, transport({ 'k-move-0': 'The parent planner item itm_parent does not exist.' }), NOW);
  assert.equal(again.outbox.operations.filter((o) => o.kind === 'create' && o.itemId === 'itm_parent').length, 1);
});

test('a block whose parent does not exist locally either has its queued changes dropped, with a notice — it can never be accepted', async () => {
  const s = state();
  const t = transport({ 'k-orphan': 'The parent planner item itm_missing does not exist.' });
  const result = await syncOnce(s, t, NOW);
  assert.match(result.repairNotice ?? '', /Dropped queued changes for a time block whose item no longer exists/);
  assert.ok(!s.outbox.operations.some((o) => o.itemId === 'blk_gone'), 'nothing left that would fail forever');
  assert.ok(s.outbox.operations.length >= 0);
});

test('other rejections are left exactly as the engine recorded them', async () => {
  const s = state();
  const result = await syncOnce(s, transport({ 'k-move-1': 'A created block needs a positive estimate.' }), NOW);
  assert.equal(result.repairNotice, undefined);
  assert.equal(s.outbox.operations[0]!.idempotencyKey, 'k-move-1');
  assert.equal(s.outbox.operations[0]!.attempts, 1);
});
