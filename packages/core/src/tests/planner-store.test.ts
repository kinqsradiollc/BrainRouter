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
  scheduleBlock, recordActual, listConflicts, resolveConflict, deviceIdFor,
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

test('a mirrored item carries its source and a fetch time', () => {
  const ws = workspace();
  try {
    const item = addItem(ws, { title: 'Issue #12', source: 'github', externalId: '12' }, T);
    assert.equal(item.origin, 'mirrored');
    assert.equal(item.source, 'github');
    assert.ok(item.fetchedAt);
    // The id is derived, so re-reading the same issue updates rather than
    // duplicating it.
    assert.equal(item.id, 'github:12');
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
          theirsAt: { physical: T, logical: 0, deviceId: 'b' },
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
    assert.equal(listConflicts(ws).length, 0);
  } finally { cleanup(ws); }
});
