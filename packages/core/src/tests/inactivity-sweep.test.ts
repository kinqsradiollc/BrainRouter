/**
 * ADR-027 D8 (P5-3) — the inactivity sweep.
 *
 * The separation these defend: archiving is reversible and happens on a timer;
 * deletion cascades and never does. A cleanup that silently removes work after
 * thirty days is indistinguishable from data loss to whoever comes back on day
 * thirty-one, and "it was in the settings" is not a defence anyone accepts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planInactivitySweep,
  planSessionDeletion,
  describeSweep,
  SESSION_CASCADE,
  DEFAULT_INACTIVE_DAYS,
  type SweepableSession,
} from '../session/inactivitySweep.js';

const NOW = '2026-08-01T00:00:00.000Z';
const daysAgo = (n: number): string => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

const session = (id: string, over: Partial<SweepableSession> = {}): SweepableSession =>
  ({ id, lastActivityAt: daysAgo(60), ...over });

test('a dormant session is archived', () => {
  const plan = planInactivitySweep([session('old')], { now: NOW });
  assert.deepEqual(plan.archive, ['old']);
});

test('an active session is neither archived nor reported', () => {
  // It is not dormant; there is nothing to explain.
  const plan = planInactivitySweep([session('fresh', { lastActivityAt: daysAgo(5) })], { now: NOW });
  assert.deepEqual(plan.archive, []);
  assert.deepEqual(plan.retained, []);
});

test('the boundary is the configured day count', () => {
  const justInside = planInactivitySweep([session('a', { lastActivityAt: daysAgo(29) })], { now: NOW });
  assert.deepEqual(justInside.archive, []);
  const justOutside = planInactivitySweep([session('a', { lastActivityAt: daysAgo(31) })], { now: NOW });
  assert.deepEqual(justOutside.archive, ['a']);
  assert.equal(DEFAULT_INACTIVE_DAYS, 30, 'D8 says 30');
});

test('a pinned session is kept AND reported, not silently skipped', () => {
  // A protected session must not look like one the sweep never considered.
  const plan = planInactivitySweep([session('kept', { pinned: true })], { now: NOW });
  assert.deepEqual(plan.archive, []);
  assert.deepEqual(plan.retained, [{ id: 'kept', reason: 'Pinned.' }]);
});

test('a dormant session with unfinished work is kept', () => {
  // Dormant by clock, not by state. Archiving a session with a running job
  // hides work that is still happening.
  const plan = planInactivitySweep([session('busy', { hasActiveWork: true })], { now: NOW });
  assert.deepEqual(plan.archive, []);
  assert.equal(plan.retained[0]!.reason, 'Has unfinished work.');
});

test('an unreadable timestamp keeps the session rather than sweeping it', () => {
  // Archiving on a date we could not parse would sweep sessions for a
  // formatting bug.
  const plan = planInactivitySweep([session('odd', { lastActivityAt: 'not a date' })], { now: NOW });
  assert.deepEqual(plan.archive, []);
  assert.match(plan.retained[0]!.reason, /could not be read/);
});

test('the sweep is idempotent — an archived session is not re-archived', () => {
  const plan = planInactivitySweep([session('done', { archived: true })], { now: NOW });
  assert.deepEqual(plan.archive, []);
  assert.deepEqual(plan.retained, [], 'nor reported: it is already handled');
});

test('archiving proceeds oldest first', () => {
  const plan = planInactivitySweep([
    session('newer', { lastActivityAt: daysAgo(40) }),
    session('oldest', { lastActivityAt: daysAgo(200) }),
    session('middle', { lastActivityAt: daysAgo(90) }),
  ], { now: NOW });
  assert.deepEqual(plan.archive, ['oldest', 'middle', 'newer']);
});

test('the sweep NEVER deletes — archiving is its only action', () => {
  // The load-bearing separation. Nothing on a timer should cascade.
  const plan = planInactivitySweep([session('old')], { now: NOW });
  assert.ok(!('delete' in plan), 'a sweep plan has no deletion channel at all');
  assert.deepEqual(Object.keys(plan).sort(), ['archive', 'retained']);
});

test('deletion cascades to everything the session owns', () => {
  const plan = planSessionDeletion('sess_1');
  assert.deepEqual(plan.cascade, SESSION_CASCADE);
  assert.deepEqual([...SESSION_CASCADE], ['transcript', 'attachments', 'artifacts', 'browser-partition']);
});

test('a deletion plan declares itself irreversible', () => {
  // The flag exists so a caller cannot mistake it for an archive.
  assert.equal(planSessionDeletion('sess_1').reversible, false);
});

test('the archive message says restoration is possible', () => {
  const text = describeSweep(planInactivitySweep([session('old')], { now: NOW }))!;
  assert.match(text, /1 dormant session\(s\) archived/);
  assert.match(text, /restore any of them/, 'the reversibility must be stated, not assumed');
});

test('retained sessions are summarised with their reasons', () => {
  const text = describeSweep(planInactivitySweep([
    session('a', { pinned: true }), session('b', { pinned: true }), session('c', { hasActiveWork: true }),
  ], { now: NOW }))!;
  assert.match(text, /3 kept/);
  assert.match(text, /2 pinned/);
});

test('a quiet sweep says nothing at all', () => {
  // It runs unattended and often; a report that always speaks gets ignored.
  assert.equal(describeSweep(planInactivitySweep([], { now: NOW })), null);
  assert.equal(
    describeSweep(planInactivitySweep([session('fresh', { lastActivityAt: daysAgo(1) })], { now: NOW })),
    null,
  );
});
