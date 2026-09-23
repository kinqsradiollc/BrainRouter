/**
 * ADR-038 — one Planner judgement suite for every host.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GROUP_LABEL,
  addDays,
  dayProgress,
  itemsForDay,
  relativeDayLabel,
  shortDayLabel,
  weekStrip,
  canEdit,
  completionLabel,
  conflictBanner,
  isCalendarEvent,
  emptyMessage,
  estimateForItem,
  formatMinutes,
  groupFor,
  keyboardBlockTime,
  layOutDay,
  localDateOf,
  noteList,
  sortForToday,
  provenanceFor,
  visibleEstimate,
  weekStart,
  weekView,
  scheduledTodayIds,
} from './viewModel.js';
import type { PlannerBlockView, PlannerItemView } from './types.js';

const TODAY = '2026-08-11';
const item = (over: Partial<PlannerItemView> & { id: string }): PlannerItemView => ({
  title: over.id,
  completed: false,
  origin: 'owned',
  conflictFields: [],
  ...over,
});
const block = (over: Partial<PlannerBlockView> & { id: string }): PlannerBlockView => ({
  itemId: 'one',
  estimateMinutes: 60,
  carriedOver: 0,
  ...over,
});

test('ADR-038 groups a day as Now, Next, and Later without a punitive overdue badge', () => {
  const scheduled = new Set(['scheduled']);
  assert.equal(groupFor(item({ id: 'old', dueDate: '2026-08-01' }), TODAY, scheduled), 'overdue');
  assert.equal(groupFor(item({ id: 'soon', dueDate: '2026-08-15' }), TODAY, scheduled), 'next');
  assert.equal(groupFor(item({ id: 'later' }), TODAY, scheduled), 'anytime');
  assert.match(GROUP_LABEL.overdue, /^Now/);
  assert.match(GROUP_LABEL.next, /^Next/);
  assert.match(GROUP_LABEL.anytime, /^Later/);
  assert.doesNotMatch(GROUP_LABEL.overdue, /late|overdue|!/i);
});

test('ADR-038 sorting stays deterministic across both hosts', () => {
  const sorted = sortForToday([
    item({ id: 'later', title: 'Later' }),
    item({ id: 'next', title: 'Next', dueDate: '2026-08-13' }),
    item({ id: 'now', title: 'Now', dueDate: TODAY }),
    item({ id: 'old', title: 'Old', dueDate: '2026-08-01' }),
  ], TODAY, new Set());
  assert.deepEqual(sorted.map((row) => row.id), ['old', 'now', 'next', 'later']);
});

test('ADR-038 keeps source-owned fields read-only and planner metadata editable', () => {
  const mirrored = item({ id: 'issue', origin: 'mirrored', source: 'GitHub' });
  assert.equal(canEdit(mirrored, 'title'), false);
  assert.equal(canEdit(mirrored, 'completed'), false);
  assert.equal(canEdit(mirrored, 'delete'), false);
  assert.equal(canEdit(mirrored, 'priority'), true);
  assert.equal(canEdit(mirrored, 'estimateMinutes'), true);
  assert.equal(canEdit(item({
    id: 'source-action',
    origin: 'mirrored',
    capabilities: { complete: true },
  }), 'completed'), true);
});

test('ADR-060 C4 — a meeting can be ticked without a host capability, because attending is nobody else\'s fact', () => {
  const meeting = item({
    id: 'evt', title: 'Team standup', origin: 'mirrored', source: 'Family',
    provenance: { source: 'Family', kind: 'connector:cal_1', documentKind: 'event' },
  });
  assert.equal(isCalendarEvent(meeting), true);
  assert.equal(canEdit(meeting, 'completed'), true);
  assert.equal(canEdit(meeting, 'title'), false, 'the calendar still owns the meeting itself');
  assert.equal(canEdit(meeting, 'delete'), false, 'un-inviting yourself is not a planner action');
  assert.equal(isCalendarEvent(item({ id: 'issue', origin: 'mirrored', source: 'GitHub' })), false);
  assert.equal(completionLabel(meeting), 'Mark Team standup as attended');
  assert.equal(completionLabel({ ...meeting, completed: true }), 'Clear attended on Team standup');
  assert.equal(completionLabel(item({ id: 'own', title: 'Team standup' })), 'Complete Team standup');
});

test('ADR-038 calendar groups local dates and lays overlapping blocks into lanes', () => {
  const first = new Date(2026, 7, 11, 9).toISOString();
  const second = new Date(2026, 7, 11, 9, 30).toISOString();
  assert.equal(localDateOf(first), TODAY);
  const days = weekView([
    block({ id: 'a', scheduledFor: first }),
    block({ id: 'b', scheduledFor: second }),
  ], weekStart(TODAY), TODAY);
  assert.equal(days.length, 7);
  const layout = layOutDay(days.find((day) => day.date === TODAY)!.blocks);
  assert.deepEqual(layout.map((position) => position.lanes), [2, 2]);
  assert.equal(keyboardBlockTime('2026-08-11T09:00:00.000Z', 'ArrowDown'), '2026-08-11T10:00:00.000Z');
  assert.equal(keyboardBlockTime('2026-08-11T09:00:00.000Z', 'ArrowRight'), '2026-08-12T09:00:00.000Z');
  assert.equal(keyboardBlockTime('not-a-date', 'ArrowDown'), null);
});

test('ADR-038 presents notes, estimates, conflicts, and useful empty states', () => {
  assert.deepEqual(noteList([item({ id: 'note', notes: 'Context' }), item({ id: 'task', dueDate: TODAY })]).map((row) => row.id), ['note']);
  assert.equal(estimateForItem('one', [block({ id: 'a', estimateMinutes: 45 }), block({ id: 'b', estimateMinutes: 30 })]), 75);
  assert.equal(visibleEstimate(item({ id: 'one', estimateMinutes: 25 }), [block({ id: 'a', estimateMinutes: 45 })]), 25);
  assert.equal(formatMinutes(75), '1h 15m');
  assert.match(conflictBanner([item({ id: 'x', conflictFields: ['title'] })])!, /Both versions were kept/);
  assert.ok(emptyMessage('today').note.length > 40);
});

test('ADR-038 prefers structured provenance and carries source freshness', () => {
  const source = provenanceFor(item({
    id: 'connected',
    origin: 'mirrored',
    source: 'legacy',
    provenance: { source: 'GitHub', kind: 'issue', externalId: '#38', url: 'https://example.test/38' },
    sourceFreshness: { label: 'Refreshed yesterday', stale: true },
  }));
  assert.deepEqual(source, {
    source: 'GitHub',
    kind: 'issue',
    externalId: '#38',
    url: 'https://example.test/38',
    freshness: { label: 'Refreshed yesterday', stale: true },
  });
});

test('"Now · scheduled" means scheduled TODAY, not merely blocked at some point', () => {
  const today = '2026-08-11';
  const blocks: PlannerBlockView[] = [
    // The two shapes that used to land under a heading that says NOW.
    { id: 'b1', itemId: 'no-time', estimateMinutes: 30, carriedOver: 0 },
    { id: 'b2', itemId: 'another-day', scheduledFor: '2026-08-13T09:00:00.000Z', estimateMinutes: 30, carriedOver: 0 },
    // The one that belongs there.
    { id: 'b3', itemId: 'today', scheduledFor: `${today}T09:00:00.000Z`, estimateMinutes: 30, carriedOver: 0 },
    // And one already dealt with.
    { id: 'b4', itemId: 'done', scheduledFor: `${today}T07:00:00.000Z`, estimateMinutes: 30, carriedOver: 0, completedAt: `${today}T07:30:00.000Z` },
  ];

  assert.deepEqual([...scheduledTodayIds(blocks, today)], ['today']);
});

test('the week strip counts what each day holds: due items, blocked-out items, finished ones, and carried work on today', () => {
  const today = '2026-09-16'; // a Wednesday
  const items = [
    { id: 'a', title: 'a', completed: false, origin: 'owned' as const, conflictFields: [], dueDate: '2026-09-14' }, // overdue → carried onto today
    { id: 'b', title: 'b', completed: false, origin: 'owned' as const, conflictFields: [], dueDate: today },
    { id: 'c', title: 'c', completed: true, origin: 'owned' as const, conflictFields: [], dueDate: today },
    { id: 'd', title: 'd', completed: false, origin: 'owned' as const, conflictFields: [] }, // blocked out on Friday
    { id: 'e', title: 'e', completed: false, origin: 'owned' as const, conflictFields: [] }, // anytime: no day
  ];
  const blocks = [
    { id: 'bd', itemId: 'd', scheduledFor: '2026-09-18T01:00:00.000Z', estimateMinutes: 30, carriedOver: 0 },
  ];
  const strip = weekStrip(items, blocks, '2026-09-14', today);
  assert.equal(strip.length, 7);
  assert.deepEqual(strip.map((d) => d.weekday), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  const wed = strip[2]!;
  assert.equal(wed.isToday, true);
  assert.equal(wed.open, 1, 'b is due today');
  assert.equal(wed.done, 1, 'c was finished today');
  assert.equal(wed.carried, 1, 'a is overdue and lands on today');
  assert.equal(strip[0]!.open, 1, 'a still shows on its own day');
  assert.equal(strip[0]!.isPast, true);
  const friday = strip.find((d) => itemsForDay(items, blocks, d.date).some((i) => i.id === 'd'))!;
  assert.ok(friday, 'a block gives an item a day');
  assert.equal(friday.open, 1);
  assert.equal(itemsForDay(items, blocks, '2026-09-20').length, 0);
});

test('today\'s progress counts the Now groups plus what was finished today, and never the Later work', () => {
  const today = '2026-09-16';
  const items = [
    { id: 'a', title: 'a', completed: false, origin: 'owned' as const, conflictFields: [], dueDate: '2026-09-14' },
    { id: 'b', title: 'b', completed: false, origin: 'owned' as const, conflictFields: [], dueDate: today },
    { id: 'c', title: 'c', completed: true, origin: 'owned' as const, conflictFields: [], dueDate: today },
    { id: 'n', title: 'n', completed: false, origin: 'owned' as const, conflictFields: [], dueDate: '2026-09-18' },
    { id: 'z', title: 'z', completed: false, origin: 'owned' as const, conflictFields: [] },
  ];
  const p = dayProgress(items, [], today);
  assert.deepEqual(p, { total: 3, done: 1, percent: 33 });
  assert.deepEqual(dayProgress([], [], today), { total: 0, done: 0, percent: 0 });
});

test('days are named the way a person says them', () => {
  assert.equal(relativeDayLabel('2026-09-16', '2026-09-16'), 'Today');
  assert.equal(relativeDayLabel('2026-09-17', '2026-09-16'), 'Tomorrow');
  assert.equal(relativeDayLabel('2026-09-15', '2026-09-16'), 'Yesterday');
  assert.equal(relativeDayLabel('2026-09-19', '2026-09-16'), 'Saturday 19 Sep');
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(shortDayLabel('2026-09-19', '2026-09-16'), 'Sat 19');
  assert.equal(shortDayLabel('2026-10-02', '2026-09-16'), 'Fri 2 Oct');
  assert.equal(shortDayLabel('2026-09-17', '2026-09-16'), 'Tomorrow');
});

