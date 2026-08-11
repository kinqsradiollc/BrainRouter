/**
 * ADR-038 D3/D4 — planner wire operations are discriminated and validated at
 * runtime, including the unstamped and stamped item payloads already in use.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlannerOperation } from '../planner/wireContract.js';

const at = { physical: 1_000, logical: 0, deviceId: 'device-a' };

test('an operation without entity remains a backward-compatible item patch', () => {
  const result = validatePlannerOperation({
    idempotencyKey: 'item:create', itemId: 'item-1', kind: 'create', at,
    payload: { title: 'Plan the day', estimateMinutes: 45 },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.operation.entity, 'item');
  assert.deepEqual(result.operation.payload, { title: 'Plan the day', estimateMinutes: 45 });
});

test('a complete stamped item is normalized instead of becoming an empty title', () => {
  const result = validatePlannerOperation({
    idempotencyKey: 'item:stamped', itemId: 'item-1', kind: 'create', at,
    payload: {
      id: 'item-1', origin: 'mirrored', source: 'github',
      fetchedAt: '2026-08-11T01:00:00.000Z',
      title: { value: 'Connected issue', at },
      blockedReason: { value: 'Waiting for review', at },
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok || result.operation.entity !== 'item' || result.operation.kind === 'resolve_conflict') return;
  assert.equal(result.operation.payload.title, 'Connected issue');
  assert.equal(result.operation.payload.blockedReason, 'Waiting for review');
  assert.equal(result.operation.payload.provenance?.sourceId, 'github');
});

test('stamped text preserves its bounded causal frontier for server-side merge', () => {
  const seen = { physical: 900, logical: 2, deviceId: 'device-before' };
  const result = validatePlannerOperation({
    idempotencyKey: 'item:causal', itemId: 'item-1', kind: 'update', at,
    payload: { title: { value: 'Observed edit', at, seen: [seen] } },
  });
  assert.equal(result.ok, true);
  if (result.ok && result.operation.entity === 'item' && result.operation.kind === 'update') {
    assert.deepEqual(result.operation.payload.titleSeen, [seen]);
  }
});

test('a block is explicit and keeps its parent item id in the payload', () => {
  const result = validatePlannerOperation({
    entity: 'block', idempotencyKey: 'block:create', itemId: 'block-1', kind: 'create', at,
    payload: { itemId: 'item-1', estimateMinutes: 30, scheduledFor: '2026-08-11T09:00:00.000Z' },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.operation.entity, 'block');
  assert.equal(result.operation.itemId, 'block-1');
  assert.equal(result.operation.payload.itemId, 'item-1');
});

test('a malformed block cannot fall through the legacy item path', () => {
  const result = validatePlannerOperation({
    entity: 'block', idempotencyKey: 'block:bad', itemId: 'block-1', kind: 'delete', at, payload: {},
  });
  assert.deepEqual(result, {
    ok: false,
    idempotencyKey: 'block:bad',
    reason: 'A block operation must be create or update.',
  });
});

test('invalid stamps and provenance are rejected with a per-operation reason', () => {
  const badClock = validatePlannerOperation({
    idempotencyKey: 'bad-clock', itemId: 'item-1', kind: 'update',
    at: { physical: -1, logical: 0, deviceId: '' }, payload: { completed: true },
  });
  assert.equal(badClock.ok, false);

  const badProvenance = validatePlannerOperation({
    idempotencyKey: 'bad-source', itemId: 'item-1', kind: 'create', at,
    payload: {
      title: 'Issue',
      provenance: { sourceId: 'github', sourceLabel: 'GitHub', sourceUrl: 'javascript:alert(1)', fetchedAt: 'today' },
    },
  });
  assert.equal(badProvenance.ok, false);

  const insecureProvenance = validatePlannerOperation({
    idempotencyKey: 'http-source', itemId: 'item-1', kind: 'create', at,
    payload: {
      title: 'Issue',
      provenance: {
        sourceId: 'github', sourceLabel: 'GitHub',
        sourceUrl: 'http://github.example/issues/1', fetchedAt: '2026-08-11T01:00:00.000Z',
      },
    },
  });
  assert.equal(insecureProvenance.ok, false);
});

test('a conflict resolution has an exact field-and-value payload', () => {
  const accepted = validatePlannerOperation({
    idempotencyKey: 'item:resolve', itemId: 'item-1', kind: 'resolve_conflict', at,
    payload: { field: 'title', value: 'Chosen title' },
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok && accepted.operation.kind === 'resolve_conflict') {
    assert.deepEqual(accepted.operation.payload, { field: 'title', value: 'Chosen title' });
  }

  const extra = validatePlannerOperation({
    idempotencyKey: 'item:resolve-extra', itemId: 'item-1', kind: 'resolve_conflict', at,
    payload: { field: 'notes', value: 'Chosen notes', title: 'not a patch' },
  });
  assert.equal(extra.ok, false);

  const deletion = validatePlannerOperation({
    idempotencyKey: 'item:resolve-delete', itemId: 'item-1', kind: 'resolve_conflict', at,
    payload: { field: 'deleted', keep: 'theirs' },
  });
  assert.equal(deletion.ok, true);
  if (deletion.ok && deletion.operation.kind === 'resolve_conflict') {
    assert.deepEqual(deletion.operation.payload, { field: 'deleted', keep: 'theirs' });
  }
  assert.equal(validatePlannerOperation({
    idempotencyKey: 'item:resolve-delete-bad', itemId: 'item-1', kind: 'resolve_conflict', at,
    payload: { field: 'deleted', keep: 'theirs', value: 'edited' },
  }).ok, false);
});

test('wire validation rejects inherited fields and custom-prototype records', () => {
  const inherited = Object.create({
    idempotencyKey: 'inherited', itemId: 'item-1', kind: 'update', at,
    payload: { completed: true },
  });
  assert.equal(validatePlannerOperation(inherited).ok, false);

  const poisonedPayload = {
    idempotencyKey: 'poisoned', itemId: 'item-1', kind: 'update', at,
    payload: Object.create({ completed: true }),
  };
  assert.equal(validatePlannerOperation(poisonedPayload).ok, false);

  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
    idempotencyKey: 'null-prototype', itemId: 'item-1', kind: 'update', at,
    payload: Object.assign(Object.create(null) as Record<string, unknown>, { completed: true }),
  });
  assert.equal(validatePlannerOperation(nullPrototype).ok, true);
});
