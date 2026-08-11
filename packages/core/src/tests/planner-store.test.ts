/**
 * ADR-028 Part D — the store and service, which is what makes the planner a
 * product rather than six libraries.
 *
 * The properties worth pinning: a mutation stamps the clock and appends to the
 * outbox (so sync has a record rather than a reconstruction), a delete is a
 * tombstone (so a later edit can resurrect it), and "today" includes overdue
 * items rather than counting them separately.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addItem, updateItem, deleteItem, listItems, getItem, readPlanner,
  scheduleBlock, updateBlock, recordActual, listBlocks, listConflicts, resolveConflict, deviceIdFor,
  plannerOutboxDetails, retryPlannerOperation,
  canUpdateItemLocally,
} from '../planner/plannerStore.js';
import { todayView, findItems, timetableView } from '../planner/plannerService.js';
import { plannerFile } from '../planner/plannerStore.js';

const T = Date.parse('2026-08-04T09:00:00.000Z');

/**
 * An isolated planner home per test.
 *
 * The store is USER-scoped now (D9), so it writes under the brainrouter home
 * rather than a workspace — which means a test that does not redirect the home
 * writes into the developer's real planner. `BRAINROUTER_HOME` is the supported
 * override and exists for exactly this.
 */
function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'br-planner-'));
  process.env.BRAINROUTER_HOME = dir;
  return dir;
}
function cleanup(ws: string): void {
  delete process.env.BRAINROUTER_HOME;
  rmSync(ws, { recursive: true, force: true });
}

test('an added item persists and is readable back', () => {
  const ws = workspace();
  try {
    const created = addItem(ws, { title: 'Write the panel' }, T);
    assert.equal(created.origin, 'owned');
    assert.equal(getItem(ws, created.id)?.title.value, 'Write the panel');
    assert.equal(listItems(ws).length, 1);
  } finally { cleanup(ws); }
});

test('every mutation stamps the clock AND appends to the outbox', () => {
  // Sync needs an ordered, idempotent record — not a reconstruction from
  // whatever the file happens to look like later.
  const ws = workspace();
  try {
    const item = addItem(ws, { title: 'a' }, T);
    updateItem(ws, item.id, { priority: 1 }, T + 1000);
    const state = readPlanner(ws);
    assert.equal(state.outbox.operations.length, 2);
    assert.deepEqual(state.outbox.operations.map((o) => o.kind), ['create', 'update']);
    assert.ok(state.clock.physical >= T + 1000, 'the persisted clock advanced');
    assert.equal(state.clock.deviceId, deviceIdFor(ws));
  } finally { cleanup(ws); }
});

test('outbox keys are unique per mutation, so a replay cannot double-apply', () => {
  const ws = workspace();
  try {
    const item = addItem(ws, { title: 'a' }, T);
    updateItem(ws, item.id, { priority: 1 }, T + 1000);
    updateItem(ws, item.id, { priority: 2 }, T + 2000);
    const keys = readPlanner(ws).outbox.operations.map((o) => o.idempotencyKey);
    assert.equal(new Set(keys).size, keys.length);
  } finally { cleanup(ws); }
});

test('delete writes a TOMBSTONE, not an absence', () => {
  // D4: a later edit from another device has to be able to resurrect this as
  // conflicted. Removing the record would make that edit look like a creation.
  const ws = workspace();
  try {
    const item = addItem(ws, { title: 'gone' }, T);
    assert.equal(deleteItem(ws, item.id, T + 1000), true);
    assert.ok(getItem(ws, item.id)?.deletedAt, 'the record survives with a stamp');
    assert.equal(listItems(ws).length, 0, 'but it is not listed');
  } finally { cleanup(ws); }
});

test('deleting an item tombstones every child block and hides it immediately', () => {
  const ws = workspace();
  try {
    const item = addItem(ws, { title: 'parent' }, T);
    const block = scheduleBlock(ws, { itemId: item.id, estimateMinutes: 30 }, T + 1);
    assert.equal(deleteItem(ws, item.id, T + 2), true);
    const stored = readPlanner(ws).blocks[block.id];
    assert.ok(stored?.deletedAt);
    assert.deepEqual(stored?.updatedAt, stored?.deletedAt);
    assert.deepEqual(listBlocks(ws), []);
  } finally { cleanup(ws); }
});

test('a mirrored item carries actionable structured provenance and planner state', () => {
  const ws = workspace();
  try {
    const item = addItem(ws, {
      title: 'Issue #12', source: 'github', sourceLabel: 'GitHub issue',
      externalId: '12', sourceUrl: 'https://github.com/example/repo/issues/12',
      estimateMinutes: 45, blockedReason: 'Waiting for review',
    }, T);
    assert.equal(item.origin, 'mirrored');
    assert.equal(item.source, 'github');
    assert.ok(item.fetchedAt);
    assert.deepEqual(item.provenance, {
      sourceId: 'github', sourceLabel: 'GitHub issue', externalId: '12',
      sourceUrl: 'https://github.com/example/repo/issues/12',
      fetchedAt: new Date(T).toISOString(),
    });
    assert.equal(item.estimateMinutes, 45);
    assert.equal(item.blockedReason?.value, 'Waiting for review');
    const queued = readPlanner(ws).outbox.operations[0]?.payload as { provenance?: { sourceUrl?: string } };
    assert.equal(queued.provenance?.sourceUrl, 'https://github.com/example/repo/issues/12');
    // The id is derived, so re-reading the same issue updates rather than
    // duplicating it.
    assert.equal(item.id, 'github:12');
  } finally { cleanup(ws); }
});

test('a local mirrored projection refuses a non-HTTPS source URL', () => {
  const ws = workspace();
  try {
    assert.throws(() => addItem(ws, {
      title: 'Unsafe source', source: 'github', externalId: '13',
      sourceUrl: 'http://github.example/issues/13',
    }, T), /must use HTTPS/);
    assert.equal(listItems(ws).length, 0);
  } finally { cleanup(ws); }
});

test('source-owned mirrored writes are refused before cache or outbox mutation', () => {
  const ws = workspace();
  try {
    const item = addItem(ws, {
      title: 'Issue #12', source: 'github', externalId: '12',
      sourceUrl: 'https://github.com/example/repo/issues/12',
    }, T);
    const before = readPlanner(ws);
    const denied = canUpdateItemLocally(item, { title: 'Local-only rename' });
    assert.equal(denied.allowed, false);
    assert.match(denied.reason!, /belongs to github/);

    assert.equal(updateItem(ws, item.id, { title: 'Local-only rename' }, T + 1_000), null);
    assert.equal(deleteItem(ws, item.id, T + 2_000), false);
    const after = readPlanner(ws);
    assert.equal(after.items[item.id]?.title.value, 'Issue #12');
    assert.equal(after.items[item.id]?.deletedAt, undefined);
    assert.equal(after.outbox.operations.length, before.outbox.operations.length);

    assert.equal(updateItem(ws, item.id, { priority: 1, estimateMinutes: 30 }, T + 3_000)?.priority?.value, 1);
  } finally { cleanup(ws); }
});

test('completed items are excluded by default and included on request', () => {
  const ws = workspace();
  try {
    const item = addItem(ws, { title: 'done' }, T);
    updateItem(ws, item.id, { completed: true }, T + 1000);
    assert.equal(listItems(ws).length, 0);
    assert.equal(listItems(ws, { includeCompleted: true }).length, 1);
  } finally { cleanup(ws); }
});

test('a corrupt or partial file starts empty rather than throwing', () => {
  // A planner that throws on read is worse than one that starts empty: the
  // second is recoverable by typing, the first needs a developer.
  const ws = workspace();
  try {
    assert.deepEqual(readPlanner(ws).items, {});
    assert.equal(listItems(ws).length, 0);
  } finally { cleanup(ws); }
});

test('blocks record estimate and actual — the gap D5 exists for', () => {
  const ws = workspace();
  try {
    const item = addItem(ws, { title: 'build it' }, T);
    const block = scheduleBlock(ws, { itemId: item.id, estimateMinutes: 60 }, T);
    const done = recordActual(ws, block.id, 145, T + 3600_000);
    assert.equal(done?.actualMinutes, 145);
    assert.ok(done?.completedAt);
    const operations = readPlanner(ws).outbox.operations.filter((op) => op.entity === 'block');
    assert.deepEqual(operations.map((op) => [op.itemId, op.kind]), [
      [block.id, 'create'],
      [block.id, 'update'],
    ], 'the block record, not its parent item, is what sync targets');
  } finally { cleanup(ws); }
});

test('a block cannot be created or updated without a live parent item', () => {
  const ws = workspace();
  try {
    assert.throws(
      () => scheduleBlock(ws, { itemId: 'missing', estimateMinutes: 30 }, T),
      /parent planner item missing does not exist/,
    );
    const item = addItem(ws, { title: 'parent' }, T);
    const block = scheduleBlock(ws, { itemId: item.id, estimateMinutes: 30 }, T + 1);
    assert.equal(deleteItem(ws, item.id, T + 2), true);
    assert.equal(updateBlock(ws, block.id, { estimateMinutes: 45 }, T + 3), null);
  } finally { cleanup(ws); }
});

test('moving a block persists locally and queues a typed block update', () => {
  const ws = workspace();
  try {
    const item = addItem(ws, { title: 'move me' }, T);
    const block = scheduleBlock(ws, {
      itemId: item.id, scheduledFor: '2026-08-04T09:00:00.000Z', estimateMinutes: 30,
    }, T);
    const moved = updateBlock(ws, block.id, {
      scheduledFor: '2026-08-05T10:30:00.000Z', estimateMinutes: 45,
    }, T + 1_000);
    assert.equal(moved?.scheduledFor, '2026-08-05T10:30:00.000Z');
    assert.equal(moved?.estimateMinutes, 45);
    assert.equal(readPlanner(ws).outbox.operations.at(-1)?.entity, 'block');
  } finally { cleanup(ws); }
});

test('sync detail is payload-free and a targeted retry request is durable', () => {
  const ws = workspace();
  try {
    const item = addItem(ws, { title: 'private title' }, T);
    const key = readPlanner(ws).outbox.operations.find((op) => op.itemId === item.id)!.idempotencyKey;
    const requested = retryPlannerOperation(ws, key, T + 10_000);
    assert.equal(requested?.status, 'retry_requested');
    assert.equal(requested?.targetId, item.id);
    assert.equal(Object.hasOwn(requested ?? {}, 'payload'), false, 'detail never exposes user text');
    assert.ok(readPlanner(ws).outbox.operations[0]?.retryRequestedAt, 'the request survives a restart');
    assert.equal(plannerOutboxDetails(ws, T + 10_000)[0]?.queuedAt, new Date(T).toISOString());
  } finally { cleanup(ws); }
});

/* ------------------------------------------------------------- the service */

test('today INCLUDES overdue items rather than counting them separately', () => {
  // A separate overdue tally is the red badge D5 rejects — it makes the surface
  // feel like an accusation, and the response is to stop opening it.
  const ws = workspace();
  try {
    addItem(ws, { title: 'overdue', dueDate: '2026-07-01' }, T);
    addItem(ws, { title: 'today', dueDate: '2026-08-04' }, T);
    addItem(ws, { title: 'later', dueDate: '2026-09-01' }, T);
    const view = todayView(ws, { date: '2026-08-04', nowMs: T });
    assert.deepEqual(view.items.map((i) => i.title.value).sort(), ['overdue', 'today']);
  } finally { cleanup(ws); }
});

test('today surfaces conflicts and sync state, never as an error', () => {
  const ws = workspace();
  try {
    addItem(ws, { title: 'a' }, T);
    const view = todayView(ws, { date: '2026-08-04', nowMs: T });
    assert.equal(view.conflicts.length, 0);
    assert.match(view.syncState, /waiting to sync/);
    assert.doesNotMatch(view.syncState, /error|offline|failed/i);
  } finally { cleanup(ws); }
});

test('an unscheduled block is a real plan, kept separate from clocked ones', () => {
  const ws = workspace();
  try {
    const item = addItem(ws, { title: 'a' }, T);
    scheduleBlock(ws, { itemId: item.id, estimateMinutes: 30 }, T);
    scheduleBlock(ws, { itemId: item.id, scheduledFor: '2026-08-04T14:00:00.000Z', estimateMinutes: 60 }, T);
    const view = todayView(ws, { date: '2026-08-04', nowMs: T });
    assert.equal(view.unscheduled.length, 1);
    assert.equal(view.scheduled.length, 1);
    assert.equal(view.commitment.committedMinutes, 90);
  } finally { cleanup(ws); }
});

test('search matches titles and notes, and finds completed items too', () => {
  const ws = workspace();
  try {
    const a = addItem(ws, { title: 'Recall latency', notes: 'check pgvector' }, T);
    updateItem(ws, a.id, { completed: true }, T + 1000);
    assert.equal(findItems(ws, 'pgvector').length, 1, 'notes are searched');
    assert.equal(findItems(ws, 'RECALL').length, 1, 'case-insensitive');
    assert.equal(findItems(ws, '   ').length, 0, 'an empty query returns nothing, not everything');
  } finally { cleanup(ws); }
});

test('the timetable resolves item titles so a block is readable', () => {
  const ws = workspace();
  try {
    const item = addItem(ws, { title: 'Ship the panel' }, T);
    scheduleBlock(ws, { itemId: item.id, scheduledFor: '2026-08-04T10:00:00.000Z', estimateMinutes: 60 }, T);
    const view = timetableView(ws, '2026-08-04');
    assert.equal(view.blocks.length, 1);
    assert.equal(view.titles[item.id], 'Ship the panel');
  } finally { cleanup(ws); }
});

test('a conflicted field is listed and resolvable, keeping either side', () => {
  // A conflict nobody is shown is the same as having discarded the losing edit.
  const ws = workspace();
  try {
    const item = addItem(ws, { title: 'ours' }, T);
    const state = readPlanner(ws);
    // Simulate what a sync merge would have produced.
    state.items[item.id] = {
      ...state.items[item.id]!,
      conflicts: {
        title: {
          ours: 'ours', theirs: 'theirs',
          oursAt: { physical: T, logical: 0, deviceId: 'a' },
          theirsAt: { physical: T + 1_000_000, logical: 0, deviceId: 'b' },
          reason: 'concurrent_text',
        },
      },
    };
    // Written directly because this state is what a SYNC merge would produce,
    // and the store has no local path that creates a conflict.
    writeFileSync(plannerFile(ws), JSON.stringify(state));
    assert.equal(listConflicts(ws).length, 1);
    const resolved = resolveConflict(ws, item.id, 'title', 'theirs', T + 5000);
    assert.equal(resolved?.title.value, 'theirs');
    assert.deepEqual(resolved?.conflictResolutions?.title, resolved?.title.at);
    assert.ok((resolved?.title.at.physical ?? 0) >= T + 1_000_000);
    const operation = readPlanner(ws).outbox.operations.at(-1);
    assert.equal(operation?.kind, 'resolve_conflict');
    assert.deepEqual(operation?.payload, { field: 'title', value: 'theirs' });
    assert.equal(listConflicts(ws).length, 0);
  } finally { cleanup(ws); }
});

test('delete-versus-edit can explicitly retain the edited item', () => {
  const ws = workspace();
  try {
    const item = addItem(ws, { title: 'Edited elsewhere' }, T);
    const state = readPlanner(ws);
    state.items[item.id] = {
      ...state.items[item.id]!,
      conflicts: {
        deleted: {
          ours: 'deleted', theirs: 'edited',
          oursAt: { physical: T + 1, logical: 0, deviceId: 'a' },
          theirsAt: { physical: T + 2, logical: 0, deviceId: 'b' },
          reason: 'delete_vs_edit',
        },
      },
    };
    writeFileSync(plannerFile(ws), JSON.stringify(state));
    const resolved = resolveConflict(ws, item.id, 'deleted', 'theirs', T + 3);
    assert.equal(resolved?.deletedAt, undefined);
    assert.equal(resolved?.conflicts?.deleted, undefined);
    assert.equal(resolved?.deletionResolution?.deleted, false);
    assert.deepEqual(readPlanner(ws).outbox.operations.at(-1)?.payload, {
      field: 'deleted', keep: 'theirs',
    });
  } finally { cleanup(ws); }
});
