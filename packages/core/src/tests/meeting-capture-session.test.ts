/**
 * ADR-035 D2/D3/D4 — the session that exists from the moment Record is pressed.
 *
 * §1's defect was that a meeting row only appeared once capture had already
 * succeeded, so a failed capture had nowhere to live. These tests hold the
 * opposite: the session exists first, every segment is an append to it, and the
 * transitions refuse the states that would let a host lose or overwrite audio.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendSegment,
  capturedByteLength,
  createCaptureSession,
  discardCapture,
  finalizeCapture,
  isMeetingSessionId,
  markDone,
  markFailed,
  markTranscribing,
  MEETING_INTERRUPTED_REASON,
  MEETING_UNFINISHED_REASON,
  newMeetingSessionId,
  recoverCaptureSession,
  resumeCapture,
  sameCaptureScope,
  stopCapture,
  unsettledSegments,
  type MeetingCaptureScope,
  type MeetingCaptureSession,
} from '../meetings/index.js';

const SCOPE: MeetingCaptureScope = { orgId: 'org-1', workspaceId: 'ws-1' };

function recording(): MeetingCaptureSession {
  return createCaptureSession({ id: 'mtg-test', scope: SCOPE, title: 'Weekly sync', startedAt: '2026-08-09T10:00:00.000Z' });
}

function withOneSegment(): MeetingCaptureSession {
  return appendSegment(recording(), { byteLength: 4096, durationMs: 20_000 });
}

test('D2 — a session exists at Record, before any audio arrives', () => {
  const session = recording();
  assert.equal(session.status, 'recording');
  assert.equal(session.segments.length, 0);
  assert.equal(session.title, 'Weekly sync');
  assert.equal(session.template, 'general');
  assert.deepEqual(session.scope, { orgId: 'org-1', workspaceId: 'ws-1' });
});

test('D6 — a minted session id is safe to name a capture directory after', () => {
  for (let i = 0; i < 20; i += 1) {
    const id = newMeetingSessionId();
    assert.ok(isMeetingSessionId(id), `${id} is not a path-safe session id`);
    assert.ok(!id.includes('/') && !id.includes('..'));
  }
  assert.throws(() => createCaptureSession({ id: '../../etc', scope: SCOPE }), /session id/);
  assert.throws(() => createCaptureSession({ id: 'a/b', scope: SCOPE }), /session id/);
});

test('open question 5 — the scope is frozen at Record and never rewritten by a transition', () => {
  const session = recording();
  const later = finalizeCapture(stopCapture(appendSegment(session, { byteLength: 10, durationMs: 1_000 })));
  assert.deepEqual(later.scope, session.scope);
  assert.ok(sameCaptureScope(later.scope, SCOPE));
  assert.ok(!sameCaptureScope(later.scope, { orgId: 'org-2', workspaceId: 'ws-1' }));
});

test('scope equality treats an absent workspace and a null workspace as one', () => {
  assert.ok(sameCaptureScope({ orgId: null }, { orgId: null, workspaceId: null }));
  assert.ok(!sameCaptureScope({ orgId: null }, { orgId: null, workspaceId: 'ws-1' }));
});

test('D3 — segments append contiguously and carry their own time range', () => {
  let session = recording();
  session = appendSegment(session, { byteLength: 100, durationMs: 20_000 });
  session = appendSegment(session, { byteLength: 120, durationMs: 20_000 });
  session = appendSegment(session, { byteLength: 90, durationMs: 15_000 });
  assert.deepEqual(
    session.segments.map((segment) => [segment.index, segment.startMs, segment.endMs]),
    [[0, 0, 20_000], [1, 20_000, 40_000], [2, 40_000, 55_000]],
  );
  assert.equal(capturedByteLength(session), 310);
  assert.ok(session.segments.every((segment) => segment.state === 'pending' && segment.attempts === 0));
});

test('a segment may start after a pause but never before the previous one ended', () => {
  const session = appendSegment(recording(), { byteLength: 100, durationMs: 20_000 });
  const paused = appendSegment(session, { byteLength: 100, durationMs: 5_000, startMs: 40_000 });
  assert.deepEqual([paused.segments[1]!.startMs, paused.segments[1]!.endMs], [40_000, 45_000]);
  assert.throws(() => appendSegment(session, { byteLength: 10, durationMs: 1_000, startMs: 5_000 }), /before the previous/);
});

test('an empty or zero-length chunk is refused — a segment record claims audio exists', () => {
  const session = recording();
  assert.throws(() => appendSegment(session, { byteLength: 0, durationMs: 1_000 }), /at least one byte/);
  assert.throws(() => appendSegment(session, { byteLength: 10, durationMs: 0 }), /positive duration/);
});

test('audio cannot be appended once capture has stopped', () => {
  const stopped = stopCapture(withOneSegment(), '2026-08-09T10:05:00.000Z');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.stoppedAt, '2026-08-09T10:05:00.000Z');
  assert.throws(() => appendSegment(stopped, { byteLength: 10, durationMs: 1_000 }), /that is stopped/);
});

test('transitions return new sessions and never mutate the one they were given', () => {
  const session = withOneSegment();
  const before = JSON.stringify(session);
  const next = markDone(markTranscribing(session, 0, '2026-08-09T10:00:20.000Z'), 0, 'hello');
  assert.equal(JSON.stringify(session), before);
  assert.notEqual(next, session);
  assert.equal(next.segments[0]!.state, 'done');
});

test('D3 — an attempt moves pending → transcribing → done and spends one attempt', () => {
  let session = withOneSegment();
  session = markTranscribing(session, 0, '2026-08-09T10:00:20.000Z');
  assert.equal(session.segments[0]!.state, 'transcribing');
  assert.equal(session.segments[0]!.attempts, 1);
  assert.equal(session.segments[0]!.lastAttemptAt, '2026-08-09T10:00:20.000Z');
  session = markDone(session, 0, 'the minutes so far');
  assert.equal(session.segments[0]!.state, 'done');
  assert.equal(session.segments[0]!.text, 'the minutes so far');
  assert.equal(unsettledSegments(session).length, 0);
});

test('D5 — a failure keeps its reason and its attempt count', () => {
  let session = withOneSegment();
  session = markTranscribing(session, 0, '2026-08-09T10:00:20.000Z');
  session = markFailed(session, 0, 'The transcription endpoint refused the request.', '2026-08-09T10:00:25.000Z');
  const segment = session.segments[0]!;
  assert.equal(segment.state, 'failed');
  assert.equal(segment.failureReason, 'The transcription endpoint refused the request.');
  assert.equal(segment.attempts, 1);
  assert.equal(segment.lastAttemptAt, '2026-08-09T10:00:25.000Z');
});

test('a failure that skipped markTranscribing still spends an attempt', () => {
  // Otherwise a host that fails synchronously — no announcement — retries forever.
  const session = markFailed(withOneSegment(), 0, 'offline', '2026-08-09T10:00:25.000Z');
  assert.equal(session.segments[0]!.attempts, 1);
});

test('a retry re-enters transcribing from failed and clears the stale reason', () => {
  let session = markFailed(withOneSegment(), 0, 'endpoint down', '2026-08-09T10:00:25.000Z');
  session = markTranscribing(session, 0, '2026-08-09T10:01:00.000Z');
  assert.equal(session.segments[0]!.state, 'transcribing');
  assert.equal(session.segments[0]!.failureReason, undefined);
  assert.equal(session.segments[0]!.attempts, 2);
});

test('D4 — a late result never overwrites text that has already settled', () => {
  const settled = markDone(markTranscribing(withOneSegment(), 0), 0, 'the settled text');
  const lateSuccess = markDone(settled, 0, 'a stale duplicate');
  const lateFailure = markFailed(settled, 0, 'a stale timeout');
  assert.equal(lateSuccess.segments[0]!.text, 'the settled text');
  assert.equal(lateSuccess, settled, 'a duplicate result should not produce a new session');
  assert.equal(lateFailure.segments[0]!.state, 'done');
  assert.equal(lateFailure.segments[0]!.text, 'the settled text');
});

test('an unknown segment index is a host bug, not a silent no-op', () => {
  assert.throws(() => markDone(withOneSegment(), 7, 'text'), /no segment 7/);
});

test('D2 — recovery corrects both lies a crash leaves behind', () => {
  let session = withOneSegment();
  session = appendSegment(session, { byteLength: 4096, durationMs: 20_000 });
  session = markDone(markTranscribing(session, 0), 0, 'first');
  session = markTranscribing(session, 1, '2026-08-09T10:00:40.000Z');
  // …and here the process dies with segment 1 still claiming to be in flight.
  const recovered = recoverCaptureSession(session, '2026-08-09T11:00:00.000Z');
  assert.equal(recovered.status, 'stopped', 'nothing is recording after a crash');
  assert.equal(recovered.segments[1]!.state, 'failed');
  assert.equal(recovered.segments[1]!.failureReason, MEETING_INTERRUPTED_REASON);
  assert.equal(recovered.segments[1]!.attempts, 1, 'the interrupted attempt still counts against the bound');
  assert.equal(recovered.segments[0]!.state, 'done', 'settled segments survive untouched');
});

test('recovery is idempotent and leaves a terminal session alone', () => {
  const once = recoverCaptureSession(withOneSegment(), '2026-08-09T11:00:00.000Z');
  const twice = recoverCaptureSession(once, '2026-08-09T12:00:00.000Z');
  assert.deepEqual(twice, once);
  const discarded = discardCapture(withOneSegment(), '2026-08-09T10:30:00.000Z');
  assert.equal(recoverCaptureSession(discarded, '2026-08-09T11:00:00.000Z'), discarded);
});

test('a recovered session can resume recording', () => {
  const recovered = recoverCaptureSession(withOneSegment(), '2026-08-09T11:00:00.000Z');
  const resumed = resumeCapture(recovered);
  assert.equal(resumed.status, 'recording');
  assert.equal(resumed.stoppedAt, undefined);
  const grown = appendSegment(resumed, { byteLength: 512, durationMs: 20_000 });
  assert.equal(grown.segments.length, 2);
});

test('D5 — finalizing turns still-untranscribed segments into stated gaps, not omissions', () => {
  let session = withOneSegment();
  session = appendSegment(session, { byteLength: 4096, durationMs: 20_000 });
  session = markDone(markTranscribing(session, 0), 0, 'first');
  const finalized = finalizeCapture(stopCapture(session), '2026-08-09T10:30:00.000Z');
  assert.equal(finalized.status, 'finalized');
  assert.equal(finalized.closedAt, '2026-08-09T10:30:00.000Z');
  assert.equal(finalized.segments.length, 2, 'no segment is dropped by finalizing');
  assert.equal(finalized.segments[1]!.state, 'failed');
  assert.equal(finalized.segments[1]!.failureReason, MEETING_UNFINISHED_REASON);
});

test('a terminal session accepts no further transitions', () => {
  const finalized = finalizeCapture(withOneSegment());
  assert.throws(() => finalizeCapture(finalized), /already finalized/);
  assert.throws(() => discardCapture(finalized), /already finalized/);
  assert.throws(() => resumeCapture(finalized), /already finalized/);
  assert.throws(() => markTranscribing(finalized, 0), /already finalized/);
  const discarded = discardCapture(withOneSegment());
  assert.equal(discarded.status, 'discarded');
  assert.throws(() => markDone(discarded, 0, 'text'), /already discarded/);
});
