import assert from 'node:assert/strict';
import test from 'node:test';

import { localSlotInstant } from './PlannerCalendar.js';

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
