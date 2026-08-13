/**
 * ADR-035 D6 — the retention window: what it means, and what a sweep may name.
 *
 * D6's third deletion trigger — "after a retention window the user can see and
 * set" — is the one that runs unattended, so the tests below are mostly about
 * what it must REFUSE to name: a capture somebody is recording into, a record
 * whose date cannot be read, and a window a torn settings file supplied.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureRetentionAt,
  createCaptureSession,
  describeMeetingRetention,
  expiredCaptureIds,
  isMeetingRetentionDays,
  MAX_MEETING_RETENTION_DAYS,
  MEETING_RETENTION_DEFAULT_DAYS,
  meetingRetentionCutoffMs,
  MIN_MEETING_RETENTION_DAYS,
  normalizeMeetingRetentionDays,
  stopCapture,
} from '../meetings/index.js';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-08-12T12:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

test('D6 — an unfiled capture older than the window is named, a younger one is not', () => {
  const expired = expiredCaptureIds(
    [
      { id: 'mtg-old', at: daysAgo(31) },
      { id: 'mtg-young', at: daysAgo(29) },
    ],
    { nowMs: NOW, days: MEETING_RETENTION_DEFAULT_DAYS },
  );
  assert.deepEqual(expired, ['mtg-old']);
});

test('D6 — the window the user set is the window the sweep uses', () => {
  const captures = [{ id: 'mtg-a', at: daysAgo(10) }];
  assert.deepEqual(expiredCaptureIds(captures, { nowMs: NOW, days: 7 }), ['mtg-a']);
  assert.deepEqual(expiredCaptureIds(captures, { nowMs: NOW, days: 30 }), []);
});

test('D6 — a capture the host says is live is never named, however old it is', () => {
  const expired = expiredCaptureIds(
    [{ id: 'mtg-live', at: daysAgo(400) }, { id: 'mtg-dead', at: daysAgo(400) }],
    { nowMs: NOW, days: MEETING_RETENTION_DEFAULT_DAYS, exclude: ['mtg-live'] },
  );
  assert.deepEqual(expired, ['mtg-dead']);
});

test('D6 — a date that cannot be read is not authority to delete', () => {
  const expired = expiredCaptureIds(
    [{ id: 'mtg-torn', at: 'not a date' }, { id: 'mtg-empty', at: '' }],
    { nowMs: NOW, days: 1 },
  );
  assert.deepEqual(expired, []);
});

test('D6 — a capture stamped in the future survives rather than expiring immediately', () => {
  const expired = expiredCaptureIds(
    [{ id: 'mtg-ahead', at: new Date(NOW + 10 * DAY_MS).toISOString() }],
    { nowMs: NOW, days: 1 },
  );
  assert.deepEqual(expired, []);
});

test('D6 — the clock runs from the stop, not from the start of a long recording', () => {
  const session = stopCapture(
    createCaptureSession({ id: 'mtg-long', scope: { orgId: null }, startedAt: daysAgo(31), title: 'long' }),
    daysAgo(1),
  );
  assert.equal(captureRetentionAt(session), daysAgo(1));
  assert.deepEqual(
    expiredCaptureIds([{ id: session.id, at: captureRetentionAt(session) }], { nowMs: NOW, days: 30 }),
    [],
  );
});

test('D6 — a capture a kill left without a stop ages from when it started', () => {
  const killed = createCaptureSession({ id: 'mtg-killed', scope: { orgId: null }, startedAt: daysAgo(31), title: 'killed' });
  assert.equal(captureRetentionAt(killed), daysAgo(31));
  assert.deepEqual(
    expiredCaptureIds([{ id: killed.id, at: captureRetentionAt(killed) }], { nowMs: NOW, days: 30 }),
    ['mtg-killed'],
  );
});

test('D6 — a stored window is clamped, and an unreadable one falls back to the default', () => {
  assert.equal(normalizeMeetingRetentionDays(5_000), MAX_MEETING_RETENTION_DAYS);
  assert.equal(normalizeMeetingRetentionDays(0), MIN_MEETING_RETENTION_DAYS);
  assert.equal(normalizeMeetingRetentionDays(-3), MIN_MEETING_RETENTION_DAYS);
  assert.equal(normalizeMeetingRetentionDays(7.4), 7);
  assert.equal(normalizeMeetingRetentionDays('30'), MEETING_RETENTION_DEFAULT_DAYS);
  assert.equal(normalizeMeetingRetentionDays(Number.NaN), MEETING_RETENTION_DEFAULT_DAYS);
  assert.equal(normalizeMeetingRetentionDays(undefined), MEETING_RETENTION_DEFAULT_DAYS);
});

test('D6 — the cutoff is the window behind the given instant, and a junk window does not move it', () => {
  assert.equal(meetingRetentionCutoffMs(NOW, 30), NOW - 30 * DAY_MS);
  assert.equal(meetingRetentionCutoffMs(NOW, Number.NaN), NOW - MEETING_RETENTION_DEFAULT_DAYS * DAY_MS);
});

test('D6 — only whole days inside the bounds are a valid stored window', () => {
  assert.equal(isMeetingRetentionDays(30), true);
  assert.equal(isMeetingRetentionDays(0), false);
  assert.equal(isMeetingRetentionDays(366), false);
  assert.equal(isMeetingRetentionDays(7.5), false);
  assert.equal(isMeetingRetentionDays('7'), false);
});

test('D6 — the sentence beside the control states the window it is set to', () => {
  assert.match(describeMeetingRetention(30), /30 days/);
  assert.match(describeMeetingRetention(1), /a day/);
  assert.match(describeMeetingRetention(365), /a year/);
  // A junk window must not print as junk: the surface says what will happen.
  assert.match(describeMeetingRetention(Number.NaN), /30 days/);
});
