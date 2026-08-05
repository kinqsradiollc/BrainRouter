/**
 * ADR-028 G6 — the planner mode's judgements.
 *
 * The properties worth pinning are the ones that keep the surface from becoming
 * something people avoid: overdue is a GROUPING rather than an accusation, a
 * mirrored item does not offer edits the next refresh would undo, and an empty
 * view says what it is for rather than that it is empty.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupFor, sortForToday, GROUP_LABEL, canEdit, whyReadOnly,
  weekStart, weekView, unscheduledBlocks, isNote, noteList,
  emptyMessage, conflictBanner,
  type PlannerItemView, type PlannerBlockView,
} from './plannerView.js';

const TODAY = '2026-08-04';
const NONE = new Set<string>();

const item = (over: Partial<PlannerItemView> & { id: string }): PlannerItemView => ({
  title: over.id, completed: false, origin: 'owned', conflictFields: [], ...over,
});
const block = (over: Partial<PlannerBlockView> & { id: string }): PlannerBlockView => ({
  itemId: 'i1', estimateMinutes: 60, carriedOver: 0, ...over,
});

/* ----------------------------------------------------------------- grouping */

test('overdue is a GROUP, not a badge — the item stays in today', () => {
  // D5 rejects a red overdue count: it makes the surface feel like an
  // accusation, and the response is to stop opening it.
  const overdue = item({ id: 'a', dueDate: '2026-07-01' });
  assert.equal(groupFor(overdue, TODAY, NONE), 'overdue');
  assert.equal(GROUP_LABEL.overdue, 'Carried over');
  assert.doesNotMatch(GROUP_LABEL.overdue, /late|overdue|!/i);
});

test('items sort overdue → due → scheduled → anytime', () => {
  const sorted = sortForToday([
    item({ id: 'anytime' }),
    item({ id: 'due', dueDate: TODAY }),
    item({ id: 'overdue', dueDate: '2026-01-01' }),
    item({ id: 'scheduled' }),
  ], TODAY, new Set(['scheduled']));
  assert.deepEqual(sorted.map((i) => i.id), ['overdue', 'due', 'scheduled', 'anytime']);
});

test('within a group, priority orders and title breaks the tie', () => {
  const sorted = sortForToday([
    item({ id: 'b', title: 'b' }),
    item({ id: 'a', title: 'a' }),
    item({ id: 'p1', title: 'z', priority: 1 }),
  ], TODAY, NONE);
  assert.deepEqual(sorted.map((i) => i.title), ['z', 'a', 'b']);
});

/* ------------------------------------------------------------- editability */

test('a mirrored item does not offer edits the next refresh would undo', () => {
  // D1: local edits to a mirrored item are limited to planner metadata.
  const mirrored = item({ id: 'gh:1', origin: 'mirrored', source: 'github' });
  assert.equal(canEdit(mirrored, 'title'), false);
  assert.equal(canEdit(mirrored, 'priority'), true, 'planner metadata IS editable');
  assert.equal(canEdit(mirrored, 'scheduledFor'), true);
  assert.match(whyReadOnly(mirrored, 'title')!, /undone by the next refresh/);
  assert.match(whyReadOnly(mirrored, 'title')!, /github/);
});

test('an owned item is fully editable and needs no explanation', () => {
  const owned = item({ id: 'a' });
  assert.equal(canEdit(owned, 'title'), true);
  assert.equal(whyReadOnly(owned, 'title'), null);
});

/* ---------------------------------------------------------------- calendar */

test('the week starts on Monday, whatever day you open it', () => {
  assert.equal(weekStart('2026-08-04'), '2026-08-03', 'Tuesday → Monday');
  assert.equal(weekStart('2026-08-03'), '2026-08-03', 'Monday → itself');
  assert.equal(weekStart('2026-08-09'), '2026-08-03', 'Sunday → the Monday BEFORE it');
});

test('a week is seven days, each carrying its own blocks and total', () => {
  const days = weekView([
    block({ id: 'b1', scheduledFor: '2026-08-04T09:00:00.000Z', estimateMinutes: 60 }),
    block({ id: 'b2', scheduledFor: '2026-08-04T11:00:00.000Z', estimateMinutes: 30 }),
  ], '2026-08-03', TODAY);
  assert.equal(days.length, 7);
  const tuesday = days.find((d) => d.date === '2026-08-04')!;
  assert.equal(tuesday.blocks.length, 2);
  assert.equal(tuesday.plannedMinutes, 90);
  assert.equal(tuesday.isToday, true);
  assert.equal(days.filter((d) => d.isToday).length, 1);
});

test('blocks within a day are in clock order', () => {
  const days = weekView([
    block({ id: 'late', scheduledFor: '2026-08-04T16:00:00.000Z' }),
    block({ id: 'early', scheduledFor: '2026-08-04T08:00:00.000Z' }),
  ], '2026-08-03', TODAY);
  const tuesday = days.find((d) => d.date === '2026-08-04')!;
  assert.deepEqual(tuesday.blocks.map((b) => b.id), ['early', 'late']);
});

test('unscheduled blocks are kept, not hidden by the calendar', () => {
  // A today list is a legitimate plan. Forcing everything onto a clock is how
  // planners get abandoned by the people who most need one.
  const loose = unscheduledBlocks([
    block({ id: 'loose' }),
    block({ id: 'timed', scheduledFor: '2026-08-04T09:00:00.000Z' }),
    block({ id: 'done', completedAt: '2026-08-04T10:00:00.000Z' }),
  ]);
  assert.deepEqual(loose.map((b) => b.id), ['loose']);
});

/* ------------------------------------------------------------------- notes */

test('a note is an item with a body and no due date', () => {
  assert.equal(isNote(item({ id: 'n', notes: 'a thought' })), true);
  assert.equal(isNote(item({ id: 't', notes: 'a thought', dueDate: TODAY })), false,
    'giving a note a due date promotes it to a task');
  assert.equal(isNote(item({ id: 'empty', notes: '   ' })), false);
  assert.equal(isNote(item({ id: 'bare' })), false);
});

test('the note list holds only notes', () => {
  assert.deepEqual(
    noteList([item({ id: 'n', notes: 'x' }), item({ id: 't', dueDate: TODAY })]).map((i) => i.id),
    ['n'],
  );
});

/* ---------------------------------------------------------------- messages */

test('an empty view says what it is FOR, not that it is empty', () => {
  // "No items" tells you nothing you did not already know from looking.
  for (const view of ['today', 'calendar', 'notes'] as const) {
    const m = emptyMessage(view);
    assert.ok(m.note.length > 30, `${view} needs a real explanation`);
    assert.doesNotMatch(m.note, /^no /i);
  }
  assert.match(emptyMessage('calendar').note, /the gap is the useful part/);
});

test('conflicts get a banner; a clean planner gets none', () => {
  assert.equal(conflictBanner([item({ id: 'a' })]), null);
  const text = conflictBanner([item({ id: 'a', conflictFields: ['title'] })])!;
  assert.match(text, /changed in two places/);
  assert.match(text, /Both versions were kept/);
  assert.match(text, /pick which/);
});
