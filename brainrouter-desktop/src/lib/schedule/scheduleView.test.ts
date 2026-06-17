import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionSchedules, describeSchedule, relTime, type ScheduleRecordView } from './scheduleView.js';

const rec = (over: Partial<ScheduleRecordView>): ScheduleRecordView => ({
  id: 'sch_1', kind: 'cron', expr: '*/15 * * * *', command: '/status', enabled: true, nextRun: '2026-06-16T12:00:00.000Z', ...over,
});

test('partitionSchedules splits enabled/disabled and sorts by next run', () => {
  const list = [
    rec({ id: 'a', enabled: true, nextRun: '2026-06-16T12:00:00.000Z' }),
    rec({ id: 'b', enabled: false, nextRun: '2026-06-16T09:00:00.000Z' }),
    rec({ id: 'c', enabled: true, nextRun: '2026-06-16T08:00:00.000Z' }),
  ];
  const { active, disabled } = partitionSchedules(list);
  assert.deepEqual(active.map((r) => r.id), ['c', 'a'], 'active sorted by nextRun');
  assert.deepEqual(disabled.map((r) => r.id), ['b']);
});

test('describeSchedule shows the cron expr for cron jobs', () => {
  assert.equal(describeSchedule(rec({ kind: 'cron', expr: '0 9 * * 1' })), 'cron · 0 9 * * 1');
});

test('describeSchedule shows a local time for one-shot jobs', () => {
  const s = describeSchedule(rec({ kind: 'once', expr: '2026-06-16T15:30:00.000Z' }));
  assert.ok(s.startsWith('once · '));
  assert.ok(!s.includes('Invalid'));
});

test('describeSchedule tolerates a malformed once expr', () => {
  assert.equal(describeSchedule(rec({ kind: 'once', expr: 'not-a-date' })), 'once · not-a-date');
});

test('relTime renders future and past compactly', () => {
  const now = Date.parse('2026-06-16T12:00:00.000Z');
  assert.equal(relTime('2026-06-16T12:12:00.000Z', now), 'in 12m');
  assert.equal(relTime('2026-06-16T09:00:00.000Z', now), '3h ago');
  assert.equal(relTime(undefined, now), '—');
  assert.equal(relTime('garbage', now), '—');
});
