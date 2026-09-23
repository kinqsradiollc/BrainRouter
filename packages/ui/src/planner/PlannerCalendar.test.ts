import assert from 'node:assert/strict';
import test from 'node:test';

import { localSlotInstant } from './PlannerCalendar.js';
import { allDayEventsOn, whyBlockTimeIsLocked } from './viewModel.js';
import type { PlannerItemView } from './types.js';

test('calendar wall time becomes an unambiguous instant in the browser timezone', () => {
  const expected = new Date(2026, 7, 11, 9, 0, 0, 0).toISOString();
  const actual = localSlotInstant('2026-08-11', 9);
  assert.equal(actual, expected);
  assert.match(actual, /Z$/);
  assert.notEqual(actual, '2026-08-11T09:00:00');
});

test('calendar rejects malformed wall-clock slots', () => {
  assert.throws(() => localSlotInstant('not-a-date', 9));
  assert.throws(() => localSlotInstant('2026-08-11', 24));
});

test('ADR-060 C4b — a meeting cannot be dragged, and an all-day event has no block to drag', () => {
  const meeting: PlannerItemView = {
    id: 'cal_1', title: 'Standup', completed: false, origin: 'mirrored',
    provenance: { source: 'Work · Google', documentKind: 'event', color: '#1a73e8' },
    conflictFields: [],
  };
  const mine: PlannerItemView = { id: 'own', title: 'Write', completed: false, origin: 'owned', conflictFields: [] };
  const locked = whyBlockTimeIsLocked(meeting);
  assert.match(locked!, /This time comes from Work · Google/);
  assert.match(locked!, /undone by the next refresh/);
  assert.equal(whyBlockTimeIsLocked(mine), null, 'the person\'s own block moves freely');
  assert.equal(whyBlockTimeIsLocked(undefined), null);

  const holiday: PlannerItemView = { ...meeting, id: 'cal_2', title: 'Public holiday', dueDate: '2026-08-13' };
  const blocks = [{ id: 'blk', itemId: 'cal_1', scheduledFor: '2026-08-13T04:00:00.000Z', estimateMinutes: 30, carriedOver: 0 }];
  assert.deepEqual(
    allDayEventsOn([meeting, holiday, mine], blocks, '2026-08-13').map((item) => item.id),
    ['cal_2'],
    'only the meeting with no hour needs the lane',
  );
  assert.deepEqual(allDayEventsOn([holiday], blocks, '2026-08-14'), [], 'and only on its own day');
});
