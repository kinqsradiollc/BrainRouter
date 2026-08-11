/**
 * ADR-035 D4/D5 — the transcript says what it does not have.
 *
 * §6's third criterion: point the STT endpoint at a black hole for sixty seconds
 * mid-meeting, and those segments must appear as marked gaps with the rest of
 * the transcript intact. The load-bearing assertion in this file is the negative
 * one — there is no path through the selector that drops a failed segment.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendSegment,
  createCaptureSession,
  formatCaptureGap,
  formatCaptureTimestamp,
  markDone,
  markFailed,
  markTranscribing,
  MEETING_GAP_PHRASE,
  transcriptGaps,
  transcriptSoFar,
  transcriptText,
  type MeetingCaptureSession,
} from '../meetings/index.js';

/** A three-segment meeting whose middle segment hit the black hole. */
function meetingWithAGap(): MeetingCaptureSession {
  let session = createCaptureSession({
    id: 'mtg-gap',
    scope: { orgId: null },
    title: 'Design review',
    startedAt: '2026-08-09T09:00:00.000Z',
  });
  session = appendSegment(session, { byteLength: 4096, durationMs: 750_000 });
  session = appendSegment(session, { byteLength: 4096, durationMs: 30_000 });
  session = appendSegment(session, { byteLength: 4096, durationMs: 30_000 });
  session = markDone(markTranscribing(session, 0), 0, 'we agreed to ship the smaller thing');
  session = markFailed(markTranscribing(session, 1), 1, 'The transcription endpoint did not respond.');
  session = markDone(markTranscribing(session, 2), 2, 'and to revisit the rest next week');
  return session;
}

test('D5 — a failed segment becomes a gap carrying its time range, and stays in the transcript', () => {
  const entries = transcriptSoFar(meetingWithAGap());
  assert.equal(entries.length, 3, 'every segment is represented');
  assert.deepEqual(entries.map((entry) => entry.kind), ['settled', 'gap', 'settled']);
  const gap = entries[1]!;
  assert.equal(gap.kind, 'gap');
  assert.equal(gap.startMs, 750_000);
  assert.equal(gap.endMs, 780_000);
  assert.equal(gap.failureReason, 'The transcription endpoint did not respond.');
  assert.equal(gap.attempts, 1);
  assert.equal(gap.text, '[00:12:30–00:13:00 could not be transcribed]');
});

test('D5 — the rendered transcript states the gap instead of silently closing over it', () => {
  const text = transcriptText(meetingWithAGap());
  assert.equal(
    text,
    ['we agreed to ship the smaller thing', '[00:12:30–00:13:00 could not be transcribed]', 'and to revisit the rest next week'].join('\n'),
  );
  assert.ok(text.includes(MEETING_GAP_PHRASE));
});

test('a failed segment never vanishes, whatever else happens to the session', () => {
  // The point of D5 is that there is no state in which the hole goes unmarked.
  const base = meetingWithAGap();
  const variants: MeetingCaptureSession[] = [
    base,
    markFailed(base, 1, 'still down'),
    markTranscribing(base, 1, '2026-08-09T09:20:00.000Z'),
  ];
  for (const session of variants) {
    assert.equal(transcriptSoFar(session).length, session.segments.length);
  }
  // Only a retry that SUCCEEDS may close the gap, and then it is real text.
  const repaired = markDone(markTranscribing(base, 1, '2026-08-09T09:20:00.000Z'), 1, 'the missing minute');
  assert.equal(transcriptGaps(repaired).length, 0);
  assert.ok(transcriptText(repaired).includes('the missing minute'));
  assert.ok(!transcriptText(repaired).includes(MEETING_GAP_PHRASE));
});

test('D4 — segments still in flight are provisional and contribute no text', () => {
  let session = createCaptureSession({ id: 'mtg-live', scope: { orgId: null }, startedAt: '2026-08-09T09:00:00.000Z' });
  session = appendSegment(session, { byteLength: 4096, durationMs: 20_000 });
  session = appendSegment(session, { byteLength: 4096, durationMs: 20_000 });
  session = markDone(markTranscribing(session, 0), 0, 'first words');
  session = markTranscribing(session, 1, '2026-08-09T09:00:40.000Z');
  const entries = transcriptSoFar(session);
  assert.deepEqual(entries.map((entry) => entry.kind), ['settled', 'provisional']);
  assert.deepEqual(entries.map((entry) => entry.state), ['done', 'transcribing']);
  assert.equal(entries[1]!.text, '');
  assert.equal(transcriptText(session), 'first words', 'no placeholder leaks into exported text');
});

test('gaps are addressable on their own for the retry affordance', () => {
  const gaps = transcriptGaps(meetingWithAGap());
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.index, 1);
});

test('omitting gaps is possible but must be asked for by name', () => {
  const text = transcriptText(meetingWithAGap(), { omitGaps: true, separator: ' ' });
  assert.ok(!text.includes(MEETING_GAP_PHRASE));
  assert.equal(text, 'we agreed to ship the smaller thing and to revisit the rest next week');
});

test('timestamps and gap markers render as hh:mm:ss', () => {
  assert.equal(formatCaptureTimestamp(0), '00:00:00');
  assert.equal(formatCaptureTimestamp(59_999), '00:00:59');
  assert.equal(formatCaptureTimestamp(3_723_000), '01:02:03');
  assert.equal(formatCaptureTimestamp(-5), '00:00:00');
  assert.equal(formatCaptureGap(750_000, 780_000), '[00:12:30–00:13:00 could not be transcribed]');
});

test('an empty meeting has an empty transcript rather than a fabricated one', () => {
  const session = createCaptureSession({ id: 'mtg-empty', scope: { orgId: null } });
  assert.deepEqual(transcriptSoFar(session), []);
  assert.equal(transcriptText(session), '');
});
