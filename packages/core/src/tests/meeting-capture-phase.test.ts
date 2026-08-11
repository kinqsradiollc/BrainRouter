/**
 * ADR-035 D5/D7 + ADR-028 — the sentence a live panel prints about the queue.
 *
 * The branch worth a test is the one that was missing when this was a private
 * function inside a component: once a segment's outage refunds are spent the
 * queue has STOPPED waiting for the endpoint on its behalf, and a surface that
 * goes on saying "the service is not answering, these will transcribe when it
 * comes back" is making a promise that has already expired — the failure this
 * ADR keeps naming, wearing a spinner.
 *
 * The sentences are asserted in full, not by fragment. Wording is what this
 * module owns, and it is what drifted while the rule lived in two hosts: one of
 * them said the segments "transcribe when it comes back" and the other that they
 * "will transcribe when it comes back". A fragment match would have let that
 * happen again here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendSegment,
  capturePhaseNote,
  createCaptureSession,
  markDone,
  markFailed,
  MEETING_ENDPOINT_UNAVAILABLE_REASON,
  MEETING_ENDPOINT_UNRESPONSIVE_REASON,
  type MeetingCaptureSession,
} from '../meetings/index.js';

const OUTAGE =
  'The transcription service is not answering. The audio is saved on this device and these segments will transcribe when it comes back.';
const SPENT =
  'We have stopped waiting for the transcription service on some segments. The audio is still on this device — retry a gap once the service is back.';
const CLOSED = 'This meeting is closed; its audio has been released.';
const NOTHING_LEFT =
  'Nothing left to try automatically — retry a gap to fill it in from the audio still on this device.';

function withSegments(count: number): MeetingCaptureSession {
  let session = createCaptureSession({ id: 'mtg-phase', scope: { orgId: null }, startedAt: '2026-08-09T10:00:00.000Z' });
  for (let index = 0; index < count; index += 1) {
    session = appendSegment(session, { byteLength: 100, durationMs: 20_000 });
  }
  return session;
}

test('an outage says the audio is safe and the segments are coming back', () => {
  assert.equal(capturePhaseNote(withSegments(2), 'unavailable', { gaps: 0, provisional: 2 }), OUTAGE);
});

test('spent refunds are said out loud, and outrank a segment still in flight', () => {
  // Without this branch a user is never told the waiting stopped: `provisional >
  // 0` returned "" and the panel showed "Queued" for ever.
  const session = markFailed(withSegments(2), 0, MEETING_ENDPOINT_UNRESPONSIVE_REASON);
  assert.equal(capturePhaseNote(session, null, { gaps: 1, provisional: 1 }), SPENT);
});

test('a live outage still outranks spent refunds — that is the state right now', () => {
  const session = markFailed(withSegments(2), 0, MEETING_ENDPOINT_UNRESPONSIVE_REASON);
  assert.equal(capturePhaseNote(session, 'unavailable', { gaps: 1, provisional: 1 }), OUTAGE);
});

test('closed outranks the spent refunds it may still be carrying', () => {
  // The audio is gone (D6), so "retry a gap once the service is back" would be
  // an instruction that cannot be followed.
  const session = markFailed(withSegments(2), 0, MEETING_ENDPOINT_UNRESPONSIVE_REASON);
  assert.equal(capturePhaseNote(session, 'closed', { gaps: 1, provisional: 1 }), CLOSED);
});

test('an ordinary failure is not mistaken for the endpoint giving up on us', () => {
  const session = markFailed(withSegments(2), 0, 'The audio could not be decoded.');
  assert.equal(capturePhaseNote(session, null, { gaps: 1, provisional: 1 }), '', 'something is still in flight');
});

test('a segment merely deferred by an outage is not the endpoint giving up either', () => {
  // D7 gives this attempt back, so the segment is still waiting its turn rather
  // than out of budget. Saying "we have stopped waiting" here would be a lie in
  // the other direction.
  const session = markFailed(withSegments(2), 0, MEETING_ENDPOINT_UNAVAILABLE_REASON);
  assert.equal(capturePhaseNote(session, null, { gaps: 1, provisional: 1 }), '');
});

test('nothing in flight and gaps left says what the person can do about them', () => {
  const session = markFailed(withSegments(2), 1, 'The audio could not be decoded.');
  assert.equal(capturePhaseNote(markDone(session, 0, 'first'), 'idle', { gaps: 1, provisional: 0 }), NOTHING_LEFT);
});

test('a backoff in progress says so rather than offering a retry that is already scheduled', () => {
  const session = markFailed(withSegments(2), 1, 'The audio could not be decoded.');
  assert.equal(capturePhaseNote(session, 'waiting', { gaps: 1, provisional: 0 }), 'Waiting to retry.');
});

test('a finished transcript and a closed meeting each say the one true thing', () => {
  const session = markDone(markDone(withSegments(2), 0, 'first'), 1, 'second');
  assert.equal(capturePhaseNote(session, 'idle', { gaps: 0, provisional: 0 }), '', 'the rows already say it');
  assert.equal(capturePhaseNote(session, 'closed', { gaps: 0, provisional: 0 }), CLOSED);
});
