/**
 * ADR-035 D2/D6 — liveness is a property of the capture, so every holder of the
 * store gets the same answer.
 *
 * The defect these cover, reproduced on both hosts: a SECOND holder of the same
 * capture store — a second desktop window over the per-process store, a second
 * browser tab over the origin-scoped one, or the same tab after leaving
 * /meetings and coming back — was offered the LIVE recording back as resumable,
 * with an enabled Delete beside it. Every guard against it lived in one mount's
 * React state, which the second holder does not have.
 *
 * So the tests below are written from the second holder's position: they judge a
 * session RECORD, with no holder identity in hand, and they check the two
 * directions that have to stay true at once — a fresh lease blocks the offer and
 * the destructive transitions, and a stale one restores both, because §6's
 * destructive test is exactly a writer that died without releasing anything.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquireCaptureLease,
  adoptCaptureChunks,
  appendSegment,
  capturesBeingWritten,
  captureLeaseStaleAt,
  createCaptureSession,
  DEFAULT_MEETING_SEGMENT_MS,
  describeCaptureWriter,
  discardCapture,
  finalizeCapture,
  heartbeatCaptureLease,
  isCaptureBeingWritten,
  isCaptureLeaseFresh,
  isResumableSession,
  liveCaptureWriter,
  markDone,
  markTranscribing,
  MEETING_CAPTURE_HEARTBEAT_MS,
  MEETING_CAPTURE_LEASE_STALE_MS,
  newCaptureHolderId,
  recoverCaptureSession,
  releaseCaptureLease,
  resumableSessions,
  stopCapture,
  type MeetingCaptureLease,
  type MeetingCaptureScope,
  type MeetingCaptureSession,
} from '../meetings/index.js';

const SCOPE: MeetingCaptureScope = { orgId: 'org-1', workspaceId: 'ws-1' };
const T0 = '2026-08-09T09:00:00.000Z';
const T0_MS = Date.parse(T0);
const STALE = MEETING_CAPTURE_LEASE_STALE_MS;

/** An instant, relative to the moment the recording started. */
function at(offsetMs: number): string {
  return new Date(T0_MS + offsetMs).toISOString();
}

/** A meeting with audio on disk — resumable in every respect except its lease. */
function recorded(id = 'mtg-live'): MeetingCaptureSession {
  const session = createCaptureSession({ id, scope: SCOPE, startedAt: T0, title: id });
  return appendSegment(session, { byteLength: 8192, durationMs: 20_000 });
}

function heldBy(holderId: string, when: string, session = recorded()): MeetingCaptureSession {
  const outcome = acquireCaptureLease(session, { holderId, holder: 'Another window' }, when);
  assert.ok(outcome.ok, 'the fixture expected to take the lease');
  return outcome.session;
}

/** What the second holder actually reads: the record, through the store, as JSON. */
function asAnotherHolderReadsIt(session: MeetingCaptureSession): MeetingCaptureSession {
  return JSON.parse(JSON.stringify(session)) as MeetingCaptureSession;
}

test('§6 — a fresh lease keeps a live recording out of the offer, and a stale one hands it back', () => {
  const live = heldBy('window-a', T0);

  assert.equal(isResumableSession(live, at(1_000)), false, 'a meeting being recorded is not somebody else’s to resume');
  assert.deepEqual(resumableSessions([live], { at: at(1_000) }), []);
  assert.equal(
    isResumableSession(live, at(STALE - 1)),
    false,
    'one millisecond inside the window the writer is still believed',
  );

  // The kill: nothing is called on the session between these two lines. The only
  // thing that changed is the clock, which is the whole point of an expiry.
  assert.equal(isResumableSession(live, at(STALE)), true, '§6 — the writer died, so the meeting comes back');
  assert.deepEqual(
    resumableSessions([live], { at: at(STALE) }).map((session) => session.id),
    ['mtg-live'],
  );
});

test('a live recording cannot be discarded or finalized by a holder that is not writing it', () => {
  const live = heldBy('window-a', T0);

  // The reproduced defect: window B holds the same store, has an empty hold, and
  // presses Delete on a meeting that is being recorded.
  assert.throws(() => discardCapture(live, at(1_000), { holderId: 'window-b' }), /recording this meeting right now/);
  assert.throws(() => finalizeCapture(live, at(1_000), { holderId: 'window-b' }), /recording this meeting right now/);
  // A caller that cannot name itself is not the writer, so it is refused too —
  // omitting the actor is not a way around the guard.
  assert.throws(() => discardCapture(live, at(1_000)), /Cannot discard this meeting/);
  assert.throws(() => finalizeCapture(live, at(1_000)), /Cannot finalize this meeting/);

  // The writer itself still owns its own recording.
  assert.equal(discardCapture(live, at(1_000), { holderId: 'window-a' }).status, 'discarded');
  assert.equal(finalizeCapture(live, at(1_000), { holderId: 'window-a' }).status, 'finalized');

  // And once the lease lapses, anyone may clean it up — otherwise a killed
  // writer would make its meeting undeletable for ever.
  assert.equal(discardCapture(live, at(STALE)).status, 'discarded');
  assert.equal(finalizeCapture(live, at(STALE)).status, 'finalized');
});

test('expiry needs no cooperation from the writer — a kill -9 releases nothing', () => {
  const live = heldBy('window-a', T0);
  // Exactly what a killed process leaves behind: the last stamp it managed to
  // write, and no release of any kind.
  assert.deepEqual(live.writer, {
    holderId: 'window-a',
    holder: 'Another window',
    epoch: 1,
    heartbeatAt: T0,
  } satisfies MeetingCaptureLease);

  assert.equal(isCaptureBeingWritten(live, at(STALE - 1)), true);
  assert.equal(isCaptureBeingWritten(live, at(STALE)), false, 'the term ends on its own or it ends never');
  assert.deepEqual(live.writer, {
    holderId: 'window-a',
    holder: 'Another window',
    epoch: 1,
    heartbeatAt: T0,
  }, 'nothing wrote to the record to expire it');
});

test('two holders reading the same record agree, and only the wording differs', () => {
  const live = heldBy('window-a', T0);
  const asWindowB = asAnotherHolderReadsIt(live);

  for (const [where, session] of [['in the writer', live], ['in another window', asWindowB]] as const) {
    assert.equal(isCaptureBeingWritten(session, at(1_000)), true, `liveness disagreed ${where}`);
    assert.equal(isResumableSession(session, at(1_000)), false, `the offer disagreed ${where}`);
    assert.equal(isCaptureBeingWritten(session, at(STALE)), false, `expiry disagreed ${where}`);
  }

  // The offer does not take a viewer, deliberately: the moment it does, it stops
  // being one rule and becomes the per-mount guard that kept failing.
  assert.equal(describeCaptureWriter(asWindowB, 'window-b', at(1_000)), 'Another window is recording this meeting right now.');
  assert.equal(describeCaptureWriter(asWindowB, 'window-a', at(1_000)), null, 'a panel does not tell you that you are recording');
  assert.equal(describeCaptureWriter(asWindowB, undefined, at(1_000)), 'Another window is recording this meeting right now.');
  assert.equal(describeCaptureWriter(asWindowB, 'window-b', at(STALE)), null, 'nothing to say once the writer is gone');

  // A host that never labelled its writer still gets a sentence, not a blank
  // one: the banner that replaces an enabled Delete button has to say something.
  const unlabelled = acquireCaptureLease(recorded(), { holderId: 'window-c' }, T0);
  assert.ok(unlabelled.ok);
  assert.equal(
    describeCaptureWriter(unlabelled.session, 'window-b', at(1_000)),
    'Another window is recording this meeting right now.',
  );
});

test('a heartbeat holds the offer off for as long as the meeting lasts', () => {
  let live = heldBy('window-a', T0);
  const claim = { holderId: 'window-a', epoch: 1 };

  for (let elapsed = MEETING_CAPTURE_HEARTBEAT_MS; elapsed <= 120_000; elapsed += MEETING_CAPTURE_HEARTBEAT_MS) {
    const beat = heartbeatCaptureLease(live, claim, at(elapsed));
    assert.ok(beat.ok, `the writer lost its own lease after ${elapsed}ms`);
    live = beat.session;
    assert.equal(live.writer?.epoch, 1, 'renewing does not move the fence');
    assert.equal(isResumableSession(live, at(elapsed)), false, `a two-minute meeting was offered away at ${elapsed}ms`);
  }

  // Two minutes in, the writer stops beating: the meeting is offered back one
  // staleness window later and not before.
  assert.equal(isResumableSession(live, at(120_000 + STALE - 1)), false);
  assert.equal(isResumableSession(live, at(120_000 + STALE)), true);
});

test('acquisition is refused while another holder is live, and fences it once it is not', () => {
  const live = heldBy('window-a', T0);

  const refused = acquireCaptureLease(live, { holderId: 'window-b' }, at(1_000));
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason, 'held_by_another');
  assert.equal(refused.ok === false && refused.holder?.holderId, 'window-a');

  const taken = acquireCaptureLease(live, { holderId: 'window-b' }, at(STALE));
  assert.ok(taken.ok);
  assert.equal(taken.lease.epoch, 2, 'taking an abandoned lease bumps past the epoch the old writer carries');

  // ADR-029/048 — the writer that was merely stalled comes back and is fenced,
  // rather than renewing its way on top of the holder that took over.
  const zombie = heartbeatCaptureLease(taken.session, { holderId: 'window-a', epoch: 1 }, at(STALE + 1));
  assert.equal(zombie.ok === false && zombie.reason, 'held_by_another');
  const stale = heartbeatCaptureLease(taken.session, { holderId: 'window-b', epoch: 1 }, at(STALE + 1));
  assert.equal(stale.ok === false && stale.reason, 'stale_epoch');
  const released = releaseCaptureLease(taken.session, { holderId: 'window-b', epoch: 1 }, at(STALE + 1));
  assert.equal(released.ok === false && released.reason, 'stale_epoch', 'a stale claim cannot free someone else’s lease');
});

test('a lapsed lease is re-acquired, never renewed', () => {
  const live = heldBy('window-a', T0);
  const late = heartbeatCaptureLease(live, { holderId: 'window-a', epoch: 1 }, at(STALE));
  assert.equal(late.ok, false, 'an unfenced renewal is how a lease keeps looking healthy under the wrong process');
  assert.equal(late.ok === false && late.reason, 'lease_expired');
  assert.equal(isResumableSession(live, at(STALE)), true, 'and the refused renewal changed nothing');

  const again = acquireCaptureLease(live, { holderId: 'window-a' }, at(STALE));
  assert.ok(again.ok);
  assert.equal(again.lease.epoch, 2, 'the reload’s own queued writes stop being honoured too');
  assert.equal(isResumableSession(again.session, at(STALE)), false);
});

test('a heartbeat or a release against a capture nobody holds says exactly that', () => {
  const plain = recorded();
  const beat = heartbeatCaptureLease(plain, { holderId: 'window-a', epoch: 1 }, at(1_000));
  assert.equal(beat.ok === false && beat.reason, 'not_held', 'a writer whose record was replaced must not be told its lease merely expired');
  const given = releaseCaptureLease(plain, { holderId: 'window-a', epoch: 1 }, at(1_000));
  assert.equal(given.ok === false && given.reason, 'not_held');
  assert.equal(isResumableSession(plain, at(1_000)), true, 'and a capture nobody ever claimed is offered as it always was');
});

test('a clean release hands the meeting back at once and keeps the fence', () => {
  const live = heldBy('window-a', T0);
  const given = releaseCaptureLease(live, { holderId: 'window-a', epoch: 1 }, at(30_000));
  assert.ok(given.ok);
  assert.equal(isCaptureBeingWritten(given.session, at(30_000)), false, 'a stopped recording is offerable immediately');
  assert.equal(given.session.writer?.epoch, 1, 'the record survives the term — a fence that can be reset is not one');
  const next = acquireCaptureLease(given.session, { holderId: 'window-b' }, at(30_001));
  assert.ok(next.ok);
  assert.equal(next.lease.epoch, 2);
});

test('the clock — a step in either direction cannot resurrect or bury a capture', () => {
  const live = heldBy('window-a', at(60_000));

  // A backward clock step makes a live writer's stamp look like the future. It
  // is honoured, because a live writer re-stamps within one heartbeat and the
  // alternative is offering away a meeting that is being recorded.
  assert.equal(isCaptureBeingWritten(live, at(60_000 - (STALE - 1))), true);
  // But only as far as a stamp in the past would be: a clock set months ahead
  // must not make a crashed meeting unrecoverable for months.
  assert.equal(isCaptureBeingWritten(live, at(60_000 - STALE)), false);
  assert.equal(isCaptureBeingWritten(live, at(60_000 - 400_000)), false);

  // A stamp nobody can read is not a lease. A live writer would have overwritten
  // it within a heartbeat, so believing it would bury the capture for ever with
  // nothing left to correct it.
  const damaged = [
    { holderId: 'window-a', epoch: 1, heartbeatAt: 'not a date' },
    { holderId: 'window-a', epoch: 1, heartbeatAt: '' },
    // A `Date` rather than the ISO string the contract asks for. It survives the
    // desktop's structured-clone IPC and `Date.parse` accepts it, so without the
    // type check this reads as a perfectly live writer — a host that stamped
    // `new Date()` by mistake would make its captures unrecoverable.
    { holderId: 'window-a', epoch: 1, heartbeatAt: new Date(T0_MS + 60_000) },
    { holderId: '', epoch: 1, heartbeatAt: at(60_000) },
    { holderId: 'window-a', epoch: 0, heartbeatAt: at(60_000) },
    { holderId: 'window-a', epoch: 1.5, heartbeatAt: at(60_000) },
  ] as unknown as MeetingCaptureLease[];
  for (const writer of damaged) {
    assert.equal(isCaptureLeaseFresh(writer, at(60_000)), false, `${JSON.stringify(writer)} was treated as a live writer`);
    assert.equal(isResumableSession({ ...recorded(), writer }, at(60_000)), true, 'a damaged lease must not hold a meeting hostage');
  }
  assert.equal(isCaptureLeaseFresh(undefined, at(0)), false);
  assert.equal(isCaptureLeaseFresh(live.writer, 'not a date'), false, 'an unreadable now is not a licence to delete');
});

test('the thresholds are the ones the two failures leave room for', () => {
  assert.ok(
    MEETING_CAPTURE_LEASE_STALE_MS >= 6 * MEETING_CAPTURE_HEARTBEAT_MS,
    'a live writer must be able to miss several beats — a stalled main thread is not a dead one',
  );
  assert.ok(
    MEETING_CAPTURE_LEASE_STALE_MS >= 1.5 * DEFAULT_MEETING_SEGMENT_MS,
    'in a throttled background tab the chunk write is the only reliable heartbeat, so the window must clear it',
  );
  assert.ok(
    MEETING_CAPTURE_LEASE_STALE_MS <= 60_000,
    '§6 kills the app and reopens it: a longer window is a meeting that looks lost',
  );
});

test('a closed meeting has no writer and cannot get one', () => {
  const finished = finalizeCapture(stopCapture(recorded()), at(1_000));
  const taken = acquireCaptureLease(finished, { holderId: 'window-a' }, at(2_000));
  assert.equal(taken.ok === false && taken.reason, 'capture_closed');
  assert.equal(isCaptureBeingWritten(finished, at(2_000)), false);

  const thrownAway = discardCapture(heldBy('window-a', T0), at(1_000), { holderId: 'window-a' });
  const beat = heartbeatCaptureLease(thrownAway, { holderId: 'window-a', epoch: 1 }, at(1_500));
  assert.equal(beat.ok === false && beat.reason, 'capture_closed');
  assert.equal(
    isResumableSession(thrownAway, at(1_500)),
    false,
    'a discarded meeting stays gone — the lease on it is not a way back in',
  );
});

test('a lease does not invent audio, and audio does not invent a lease', () => {
  const empty = createCaptureSession({ id: 'mtg-cancelled', scope: SCOPE, startedAt: T0 });
  const held = heldBy('window-a', T0, empty);
  assert.equal(isResumableSession(held, at(1_000)), false, 'a Record with no audio is still not an offer');
  assert.equal(isResumableSession(held, at(STALE)), false);
  assert.equal(isResumableSession(recorded(), at(STALE)), true, 'and audio with no lease is offered as it always was');
});

test('the reap and the Create guard read the same fact off the records', () => {
  const live = heldBy('window-a', T0, recorded('mtg-live'));
  const abandoned = heldBy('window-b', T0, recorded('mtg-abandoned'));
  const neverLeased = recorded('mtg-plain');
  const sessions = [live, abandoned, neverLeased];

  assert.deepEqual(
    capturesBeingWritten(sessions, at(1_000)).map((session) => session.id),
    ['mtg-live', 'mtg-abandoned'],
  );
  const stillRecording = heartbeatCaptureLease(live, { holderId: 'window-a', epoch: 1 }, at(STALE - 1_000));
  assert.ok(stillRecording.ok);
  assert.deepEqual(
    capturesBeingWritten([stillRecording.session, abandoned, neverLeased], at(STALE)).map((session) => session.id),
    ['mtg-live'],
    'the one that kept beating is kept; the one that stopped is reapable',
  );
});

test('a surface can say when a live capture will be offered instead of showing nothing', () => {
  const live = heldBy('window-a', at(5_000));
  assert.equal(captureLeaseStaleAt(live.writer), at(5_000 + STALE));
  assert.equal(captureLeaseStaleAt(undefined), undefined);
  assert.equal(captureLeaseStaleAt({ holderId: 'window-a', epoch: 1, heartbeatAt: 'nope' }), undefined);
  assert.equal(liveCaptureWriter(live, at(5_000))?.holderId, 'window-a');
  assert.equal(liveCaptureWriter(live, at(5_000 + STALE)), undefined);
});

test('the lease survives every transition a recovery pass runs a session through', () => {
  const live = heldBy('window-a', T0);

  // The dashboard restores a session on EVERY read, including in the tab that is
  // not recording — so if any of these dropped the lease, the second tab would
  // compute a session with no writer and offer the live recording back.
  const recoveredSession = recoverCaptureSession(live, at(1_000));
  assert.deepEqual(recoveredSession.writer, live.writer, 'recovery must not clear a writer that is still writing');
  assert.equal(isResumableSession(recoveredSession, at(1_000)), false);

  const adopted = adoptCaptureChunks(recoveredSession, [{ sequence: 1, byteLength: 4_096 }]);
  assert.equal(adopted.adopted.length, 1);
  assert.deepEqual(adopted.session.writer, live.writer, 'believing the chunks must not forget the writer');

  const transcribed = markDone(markTranscribing(adopted.session, 0, at(1_000)), 0, 'the first twenty seconds');
  assert.deepEqual(transcribed.writer, live.writer);
  assert.deepEqual(stopCapture(transcribed, at(2_000)).writer, live.writer);
  assert.equal(isResumableSession(stopCapture(transcribed, at(2_000)), at(2_000)), false);
});

test('a holder id is unique per window, with and without a secure context', () => {
  assert.notEqual(
    newCaptureHolderId(),
    newCaptureHolderId(),
    'two windows sharing a holder id would each mistake the other for itself, and the guard would pass',
  );
  assert.match(newCaptureHolderId(), /^wr-.+/);

  // The dashboard is not always served from a secure context, so `randomUUID`
  // is not always there — and a fallback that handed every tab the same id
  // would defeat the whole guard on exactly the host that has second tabs.
  const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  try {
    const ids = new Set(Array.from({ length: 32 }, () => newCaptureHolderId()));
    assert.equal(ids.size, 32, 'the plain-http fallback handed two windows the same holder id');
    for (const id of ids) assert.match(id, /^wr-.+/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', real);
  }
});
