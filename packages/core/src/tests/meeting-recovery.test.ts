/**
 * ADR-035 D2/D6 — what survives the kill.
 *
 * §6's destructive test, reduced to the part that is not host-specific: given
 * the sessions a host persisted, which does it offer back? A session with audio
 * and no terminal state, and nothing else — offering back an abandoned empty
 * Record teaches the user to dismiss the prompt, and offering back a discarded
 * meeting is a product that will not forget what it was told to forget.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendSegment,
  createCaptureSession,
  discardCapture,
  finalizeCapture,
  isResumableSession,
  markDone,
  markFailed,
  markTranscribing,
  orphanCaptureIds,
  recoverCaptureSession,
  resumableSessions,
  stopCapture,
  summarizeRecovery,
  type MeetingCaptureScope,
  type MeetingCaptureSession,
} from '../meetings/index.js';

const ORG_ONE: MeetingCaptureScope = { orgId: 'org-1', workspaceId: 'ws-1' };
const ORG_TWO: MeetingCaptureScope = { orgId: 'org-2', workspaceId: 'ws-1' };

function captured(id: string, startedAt: string, scope: MeetingCaptureScope = ORG_ONE): MeetingCaptureSession {
  const session = createCaptureSession({ id, scope, startedAt, title: id });
  return appendSegment(session, { byteLength: 8192, durationMs: 20_000 });
}

test('D2 — a session with audio and no terminal state is resumable', () => {
  const crashed = captured('mtg-crashed', '2026-08-09T09:00:00.000Z');
  assert.equal(crashed.status, 'recording', 'the persisted status still says recording after a kill');
  assert.ok(isResumableSession(crashed));
  assert.ok(isResumableSession(stopCapture(crashed)), 'a cleanly stopped meeting is still unfinished work');
  assert.ok(isResumableSession(recoverCaptureSession(crashed)));
});

test('a session with no audio is not offered back', () => {
  const empty = createCaptureSession({ id: 'mtg-empty', scope: ORG_ONE, startedAt: '2026-08-09T09:00:00.000Z' });
  assert.ok(!isResumableSession(empty));
  assert.ok(!isResumableSession(stopCapture(empty)));
});

test('a terminal session is never offered back, however much audio it holds', () => {
  const session = captured('mtg-done', '2026-08-09T09:00:00.000Z');
  assert.ok(!isResumableSession(finalizeCapture(session)));
  assert.ok(!isResumableSession(discardCapture(session)));
});

test('a resumable meeting still holds its audio and its settled text', () => {
  let session = captured('mtg-partial', '2026-08-09T09:00:00.000Z');
  session = appendSegment(session, { byteLength: 8192, durationMs: 20_000 });
  session = markDone(markTranscribing(session, 0), 0, 'the first twenty seconds');
  session = markFailed(markTranscribing(session, 1), 1, 'endpoint unreachable');
  const recovered = recoverCaptureSession(session, '2026-08-09T10:00:00.000Z');
  assert.ok(isResumableSession(recovered));
  const summary = summarizeRecovery(recovered);
  assert.deepEqual(summary, {
    sessionId: 'mtg-partial',
    title: 'mtg-partial',
    startedAt: '2026-08-09T09:00:00.000Z',
    durationMs: 40_000,
    byteLength: 16_384,
    segments: 2,
    settled: 1,
    gaps: 1,
    unsettled: 0,
  });
});

test('the offer is newest first', () => {
  const sessions = [
    captured('mtg-old', '2026-08-09T08:00:00.000Z'),
    captured('mtg-new', '2026-08-09T11:00:00.000Z'),
    captured('mtg-mid', '2026-08-09T09:30:00.000Z'),
  ];
  assert.deepEqual(resumableSessions(sessions).map((session) => session.id), ['mtg-new', 'mtg-mid', 'mtg-old']);
  assert.equal(sessions[0]!.id, 'mtg-old', 'the input array is not reordered in place');
});

test('open question 5 — the offer is filtered to the scope now in context', () => {
  const sessions = [
    captured('mtg-org-1', '2026-08-09T09:00:00.000Z', ORG_ONE),
    captured('mtg-org-2', '2026-08-09T10:00:00.000Z', ORG_TWO),
  ];
  assert.deepEqual(resumableSessions(sessions, { scope: ORG_ONE }).map((s) => s.id), ['mtg-org-1']);
  assert.deepEqual(resumableSessions(sessions, { scope: ORG_TWO }).map((s) => s.id), ['mtg-org-2']);
  assert.equal(resumableSessions(sessions).length, 2, 'omitting the scope considers every session');
});

test('finalized and empty sessions are filtered out of the offer', () => {
  const sessions = [
    finalizeCapture(captured('mtg-accepted', '2026-08-09T09:00:00.000Z')),
    discardCapture(captured('mtg-thrown-away', '2026-08-09T09:10:00.000Z')),
    createCaptureSession({ id: 'mtg-cancelled', scope: ORG_ONE, startedAt: '2026-08-09T09:20:00.000Z' }),
    captured('mtg-real', '2026-08-09T09:30:00.000Z'),
  ];
  assert.deepEqual(resumableSessions(sessions).map((session) => session.id), ['mtg-real']);
});

test('D6 — capture stores with no session record are reapable orphans', () => {
  const sessions = [captured('mtg-known', '2026-08-09T09:00:00.000Z')];
  assert.deepEqual(orphanCaptureIds(['mtg-known', 'mtg-stray', 'mtg-older-stray'], sessions), ['mtg-stray', 'mtg-older-stray']);
  assert.deepEqual(orphanCaptureIds([], sessions), []);
});
