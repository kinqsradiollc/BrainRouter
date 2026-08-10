/**
 * ADR-035 D3/D5/D7 — what the host-owned queue has to be true about.
 *
 * §6 names three things beyond the destructive test, and each of the first three
 * tests here is one of them made checkable without a microphone or a sidecar:
 *
 * - **A meeting longer than the body limit completes**, because no request ever
 *   carries the whole thing — asserted as "every request is one segment".
 * - **A failed segment is visible and recoverable** — it becomes a stated gap
 *   with its time range, and the retry fills it in from the audio on disk.
 * - **A meeting never fails because a server was down** (D7) — an outage costs
 *   no retry budget and the queue drains when the endpoint returns.
 *
 * The fourth is the one this ADR exists for: a process that died mid-meeting
 * leaves segments on disk, and a NEW supervisor over the recovered record
 * finishes them. That is the queue surviving the thing that killed the last one.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MeetingEndpointUnavailableError,
  MEETING_GAP_PHRASE,
  transcriptText,
  type MeetingCaptureSession,
} from '@kinqs/brainrouter-core/meetings';
import { MeetingCaptureStore, MEETING_CAPTURE_DIRECTORY } from './meetingCapture.js';
import {
  MeetingTranscriptionSupervisor,
  MEETING_CAPTURE_WRITER_NOTE,
  type MeetingCaptureProgress,
} from './meetingTranscription.js';

function userData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-meeting-queue-'));
}

/** What the store has on disk. `stored` also carries the recorder MIME, which no assertion here wants. */
async function record(store: MeetingCaptureStore, id: string): Promise<MeetingCaptureSession> {
  return (await store.stored(id)).session;
}

function captureDirectory(home: string, id: string): string {
  return path.join(home, MEETING_CAPTURE_DIRECTORY, id);
}

interface Harness {
  readonly home: string;
  readonly store: MeetingCaptureStore;
  readonly supervisor: MeetingTranscriptionSupervisor;
  /** One entry per request that reached the "endpoint", newest last. */
  readonly requests: number[];
  readonly published: MeetingCaptureProgress[];
  /** Every delay the supervisor asked to be woken after, in the order it asked. */
  readonly wakeDelays: number[];
  /** Backoff wakes the supervisor asked for, so a test can run them at once. */
  runWakes(): Promise<void>;
}

function harness(
  transcribe: (bytes: Uint8Array, attempt: number) => Promise<string>,
  home = userData(),
): Harness {
  const store = new MeetingCaptureStore(home);
  const requests: number[] = [];
  const published: MeetingCaptureProgress[] = [];
  const wakes: Array<{ run: () => void; delayMs: number }> = [];
  const wakeDelays: number[] = [];
  const clock = { nowMs: Date.parse('2026-08-10T09:00:00.000Z') };
  const supervisor = new MeetingTranscriptionSupervisor(store, {
    transcribe: async ({ bytes }) => {
      requests.push(bytes.byteLength);
      return await transcribe(bytes, requests.length);
    },
    publish: (progress) => { published.push(progress); },
    // No real timers, and no real clock: a test that waited out an exponential
    // backoff would be a test nobody runs. Firing a wake moves the clock by the
    // delay that was asked for, because the queue serves its own cooldown from
    // the clock and would otherwise refuse the probe the timer just triggered.
    schedule: (run, delayMs) => { wakes.push({ run, delayMs }); wakeDelays.push(delayMs); return () => undefined; },
    now: () => clock.nowMs,
  });
  return {
    home,
    store,
    supervisor,
    requests,
    published,
    wakeDelays,
    async runWakes() {
      for (const wake of wakes.splice(0, wakes.length)) {
        clock.nowMs += wake.delayMs;
        wake.run();
        await Promise.resolve();
      }
    },
  };
}

test('every segment is transcribed on its own, and the text is persisted as it lands', async () => {
  const { store, supervisor, requests, published } = harness(async (bytes) => `chunk-${bytes.byteLength}`);
  const session = await supervisor.begin({ scope: { orgId: 'org_1' }, title: 'Long meeting' });

  await supervisor.append(session.id, new Uint8Array([1, 2]), 20_000);
  await supervisor.append(session.id, new Uint8Array([3, 4, 5]), 20_000);
  await supervisor.settle(session.id);

  // §6 — nothing ever posts the whole capture, so a meeting past the 40 MB body
  // limit is not a meeting that fails. Each request carried exactly one segment.
  assert.deepEqual(requests, [2, 3]);
  const stored = await record(store, session.id);
  assert.deepEqual(stored.segments.map((segment) => [segment.state, segment.text]), [['done', 'chunk-2'], ['done', 'chunk-3']]);
  assert.equal(transcriptText(stored), 'chunk-2\nchunk-3');
  // D4 — the surface is told, and only ever about a record already on disk.
  assert.ok(published.some((progress) => progress.session.segments[1]?.state === 'done'));
  assert.equal(published.at(-1)?.sessionId, session.id);
});

/**
 * A WebM prologue followed by the first `Cluster` element id, which is where a
 * recording stops being description and starts being audio.
 */
const WEBM_HEADER = [0x1a, 0x45, 0xdf, 0xa3, 0x99];
const WEBM_CLUSTER = [0x1f, 0x43, 0xb6, 0x75];

test('a segment after the first is posted with the container header in front of it', async () => {
  const posted: Uint8Array[] = [];
  // What `MediaRecorder` actually produces on a timeslice: the container header
  // in the FIRST blob only, and bare media fragments after it.
  const first = Uint8Array.from([...WEBM_HEADER, ...WEBM_CLUSTER, 0x01]);
  const second = Uint8Array.from([...WEBM_CLUSTER, 0x02]);
  const framed = Uint8Array.from([...WEBM_HEADER, ...WEBM_CLUSTER, 0x02]);

  const { supervisor, home } = harness(async (bytes, attempt) => {
    posted.push(bytes.slice());
    // The endpoint is down for the second segment only, so that segment is still
    // unfinished when the process dies below — which is the case the restart
    // below has to answer, and D7 says it costs the segment nothing.
    if (attempt === 2) throw new MeetingEndpointUnavailableError();
    return `chunk-${attempt}`;
  });
  const session = await supervisor.begin({ scope: { orgId: null }, title: 'Framed' });
  await supervisor.append(session.id, first, 20_000);
  await supervisor.append(session.id, second, 20_000);
  await supervisor.settle(session.id);

  // Segment 0 is already a complete file and is passed through untouched;
  // copying it would double the largest allocation on the recording path.
  assert.deepEqual(posted[0], first);
  // Segment 1 is a bare fragment, and `ffmpeg -i` refuses one. Posting it as it
  // came off the disk is what made this host transcribe segment 0 and nothing
  // else — twenty seconds of text and a hundred rows reading "Queued" for ever,
  // which looks exactly like the feature working.
  assert.deepEqual(posted[1], framed);

  // The app is killed here. A NEW supervisor is asked for segment 1 having never
  // read segment 0, so the header has to be fetched on demand rather than
  // remembered from a read this process never made.
  const restarted = harness(async (bytes) => { posted.push(bytes.slice()); return 'after-restart'; }, home);
  await restarted.store.recoverInterrupted();
  await restarted.supervisor.adopt(session.id);
  await restarted.supervisor.settle(session.id);
  assert.deepEqual(posted[2], framed);
});

test('an outage costs no retry budget and drains when the endpoint returns', async () => {
  let down = true;
  const { store, supervisor, requests, runWakes } = harness(async () => {
    if (down) throw new MeetingEndpointUnavailableError();
    return 'recovered';
  });
  const session = await supervisor.begin({ scope: { orgId: null } });
  await supervisor.append(session.id, new Uint8Array([1]), 20_000);
  await supervisor.settle(session.id);

  // D7 — the endpoint is a fact about the server, not about the audio. The
  // segment is queued, not failed, and has spent nothing.
  const during = await record(store, session.id);
  assert.equal(during.segments[0]?.state, 'pending');
  assert.equal(during.segments[0]?.attempts, 0);

  down = false;
  await runWakes();
  await supervisor.settle(session.id);

  assert.equal((await record(store, session.id)).segments[0]?.text, 'recovered');
  assert.ok(requests.length >= 2);
});

test('a queue that stopped with work still ready is woken on the shared floor, not immediately', async () => {
  const { store, supervisor, requests, wakeDelays } = harness(async () => 'never reached');
  const session = await supervisor.begin({ scope: { orgId: null } });
  // The one case the floor exists for: the RECORD cannot be written, so the
  // attempt is never announced and the segment stays ready with nothing spent.
  // The queue answers `nextWakeMs: 0` — "come back", not "idle" — and honouring
  // that literally spins the main process against a disk already refusing it.
  // Only the `transcribing` write fails, so the chunk itself still lands and
  // this is the state a full disk actually produces rather than a broken store.
  const persist = store.persist.bind(store);
  store.persist = async (next) => {
    if (next.segments.some((segment) => segment.state === 'transcribing')) throw new Error('no space left on device');
    return await persist(next);
  };
  await supervisor.append(session.id, new Uint8Array([1, 2]), 20_000);
  await supervisor.settle(session.id);

  // Nothing was sent, because the attempt could not be recorded…
  assert.deepEqual(requests, []);
  // …and the wake is the shared floor rather than the zero the queue reported.
  assert.ok(wakeDelays.length > 0, 'the supervisor scheduled another drain');
  assert.deepEqual(wakeDelays.filter((delay) => delay < 500), []);
  assert.equal(wakeDelays[0], 500);
});

test('a real backoff passes through the floor untouched', async () => {
  const { supervisor, wakeDelays } = harness(async () => { throw new Error('sidecar said no'); });
  const session = await supervisor.begin({ scope: { orgId: null } });
  await supervisor.append(session.id, new Uint8Array([1]), 20_000);
  await supervisor.settle(session.id);

  // The floor only ever binds on the error path above: the retry policy's base
  // delay is 2 s, four times the floor, and a floor that started clamping real
  // backoffs would be a retry rule wearing a scheduler's clothes.
  assert.ok(wakeDelays.length > 0, 'a failed segment schedules its retry');
  assert.ok(wakeDelays[0] !== undefined && wakeDelays[0] >= 2000, `expected the policy's backoff, got ${String(wakeDelays[0])}`);
});

test('a segment that cannot be transcribed becomes a stated gap, and the retry fills it in', async () => {
  let answer: string | null = null;
  const { store, supervisor, runWakes } = harness(async () => {
    if (answer === null) throw new Error('That audio could not be decoded.');
    return answer;
  });
  const session = await supervisor.begin({ scope: { orgId: null } });
  await supervisor.append(session.id, new Uint8Array([1, 2, 3]), 30_000);

  // Four attempts over the shared policy's backoff, then the queue stops asking.
  for (let pass = 0; pass < 6; pass += 1) {
    await supervisor.settle(session.id);
    await runWakes();
  }
  await supervisor.settle(session.id);

  const failed = await record(store, session.id);
  assert.equal(failed.segments[0]?.state, 'failed');
  assert.equal(failed.segments[0]?.attempts, 4);
  // D5 — a hole in a transcript is quietly wrong; this says where it is.
  const gap = transcriptText(failed);
  assert.match(gap, new RegExp(MEETING_GAP_PHRASE));
  assert.match(gap, /00:00:00–00:00:30/);

  // …and the audio is still on disk, so a person asking again is answerable.
  answer = 'filled in';
  const retried = await supervisor.retry(session.id, 0);
  assert.equal(retried.segments[0]?.text, 'filled in');
  assert.equal(transcriptText(await record(store, session.id)), 'filled in');
});

test('a new process finishes the segments the last one left behind', async () => {
  const first = harness(async () => { throw new MeetingEndpointUnavailableError(); });
  const session = await first.supervisor.begin({ scope: { orgId: null }, title: 'Interrupted' });
  await first.supervisor.append(session.id, new Uint8Array([1, 2]), 20_000);
  await first.supervisor.append(session.id, new Uint8Array([3, 4]), 20_000);
  await first.supervisor.settle(session.id);
  assert.deepEqual((await record(first.store, session.id)).segments.map((segment) => segment.state), ['pending', 'pending']);

  // The app is killed here. A new launch runs the boot pass and a NEW supervisor
  // over the same directory — the queue is restartable because it holds no work
  // list, only the record on disk.
  const { store, supervisor, requests } = harness(async (bytes) => `after-restart-${bytes.byteLength}`, first.home);
  await store.recoverInterrupted();

  await supervisor.adopt(session.id);
  await supervisor.settle(session.id);

  assert.deepEqual(requests, [2, 2]);
  assert.equal(transcriptText(await record(store, session.id)), 'after-restart-2\nafter-restart-2');
});

test('closing a capture stops the queue before the audio is deleted', async () => {
  let release = (): void => undefined;
  const inFlight = new Promise<void>((resolve) => { release = resolve; });
  const { home, store, supervisor, published } = harness(async () => { await inFlight; return 'late'; });
  const session = await supervisor.begin({ scope: { orgId: null } });
  await supervisor.append(session.id, new Uint8Array([1]), 20_000);
  // The transcription is still in flight when the user accepts the meeting.
  const closing = supervisor.close(session.id, 'finalize');
  release();
  await closing;

  // D6 — a real deletion, and the late result did not rewrite a record for a
  // directory that no longer exists.
  assert.equal(fs.existsSync(captureDirectory(home, session.id)), false);
  assert.deepEqual(await store.resumable(), []);
  assert.ok(published.every((progress) => progress.session.segments.every((segment) => segment.text !== 'late')));
});

/**
 * D6 — who is recording is a question THIS PROCESS answers exactly.
 *
 * The supervisor is created once per process and every BrowserWindow lives in
 * that process, so "is somebody recording into this capture?" is a lookup rather
 * than an inference. These tests are the four transitions that lookup has —
 * Record, Stop, close, and the window going away — and the one property the
 * previous shape (a lease with a heartbeat) got wrong in the direction that
 * costs a meeting.
 *
 * Nothing here has a clock in it, deliberately. There is no term to expire, so
 * there is no threshold to tune and no window in which a dead writer still looks
 * alive: a renderer that reloaded reports `releaseWindow` and stops being the
 * writer at that instant, where a heartbeat main owned kept a recording claimed
 * for a page that no longer existed.
 */
test('a recording says which window is making it, until that window stops', async () => {
  const { store, supervisor } = harness(async () => 'text');
  const session = await supervisor.begin({ scope: { orgId: null }, writerId: 'wr-me' });

  assert.deepEqual(await supervisor.writing(), [
    { sessionId: session.id, holderId: 'wr-me', note: MEETING_CAPTURE_WRITER_NOTE },
  ]);
  assert.equal(supervisor.isWriting(session.id), true);
  // The claim is in the PROCESS and not in the record: nothing about a writer is
  // written to disk, so there is nothing on disk that can be stale.
  assert.equal('writer' in (await record(store, session.id)), false);

  await supervisor.append(session.id, new Uint8Array([1, 2]), 20_000);
  await supervisor.settle(session.id);
  assert.equal(supervisor.isWriting(session.id), true);

  await supervisor.stop(session.id);
  assert.deepEqual(await supervisor.writing(), []);
  assert.equal(supervisor.isWriting(session.id), false);
  // …and the meeting is offerable to any window AT ONCE, rather than after a
  // staleness window somebody has to sit through.
  assert.deepEqual((await store.resumable()).map((row) => row.sessionId), [session.id]);
});

test('the org filter applies to who is recording, as it does to the offer', async () => {
  const { supervisor } = harness(async () => 'text');
  const mine = await supervisor.begin({ scope: { orgId: 'org_1' }, writerId: 'wr-me' });
  await supervisor.begin({ scope: { orgId: 'org_2' }, writerId: 'wr-me' });

  // A live recording in another workspace is not something this one has to
  // explain, or could act on (open question 5).
  assert.deepEqual((await supervisor.writing({ orgId: 'org_1' })).map((row) => row.sessionId), [mine.id]);
  assert.deepEqual(await supervisor.writing({ orgId: 'org_3' }), []);
});

test('a second window can neither pick up nor close a recording another one is making', async () => {
  const { home, store, supervisor } = harness(async (bytes) => `chunk-${bytes.byteLength}`);
  const session = await supervisor.begin({ scope: { orgId: null }, writerId: 'wr-first' });
  await supervisor.append(session.id, new Uint8Array([1, 2]), 20_000);
  await supervisor.settle(session.id);

  await assert.rejects(() => supervisor.adopt(session.id, 'wr-second'), /recording this meeting right now/);
  await assert.rejects(() => supervisor.close(session.id, 'discard', 'wr-second'), /recording this meeting right now/);
  await assert.rejects(() => supervisor.close(session.id, 'finalize', 'wr-second'), /recording this meeting right now/);

  // THE POINT, and the defect this ordering was written for: a refused
  // destructive action must leave the live capture exactly as it was. The
  // refusal used to happen inside the store, AFTER this supervisor had dropped
  // the entry, marked it closed and stopped its timers — and the supervisor is
  // per PROCESS, so those were the RECORDING window's. Measured: the heartbeat
  // froze at the refusal and thirty-one seconds later the same button deleted
  // the meeting with the microphone still open.
  assert.ok(fs.existsSync(captureDirectory(home, session.id)), 'the audio survived the refused delete');
  assert.deepEqual(await supervisor.writing(), [
    { sessionId: session.id, holderId: 'wr-first', note: MEETING_CAPTURE_WRITER_NOTE },
  ], 'the recording window is still the writer');
  // …and its queue is still working, rather than inert against ports a close
  // turned off underneath it.
  await supervisor.append(session.id, new Uint8Array([3, 4, 5]), 20_000);
  await supervisor.settle(session.id);
  assert.deepEqual(
    (await record(store, session.id)).segments.map((segment) => [segment.state, segment.text]),
    [['done', 'chunk-2'], ['done', 'chunk-3']],
  );
  // …so the second window's next click is refused for the same reason as its
  // first, however long it waits.
  await assert.rejects(() => supervisor.close(session.id, 'discard', 'wr-second'), /recording this meeting right now/);

  // The window that IS recording it may still finish the meeting, or the guard
  // would have wedged the one window entitled to press the button.
  await supervisor.close(session.id, 'finalize', 'wr-first');
  assert.equal(fs.existsSync(captureDirectory(home, session.id)), false);
});

test('a window that goes away stops being the writer, and its recording is offered back', async () => {
  const { home, store, supervisor } = harness(async () => 'text');
  const session = await supervisor.begin({ scope: { orgId: null }, writerId: 'wr-first' });
  await supervisor.append(session.id, new Uint8Array([1, 2]), 20_000);
  await supervisor.settle(session.id);

  // A RELOAD, which is the case a lease could not see: main is untouched by one,
  // so a heartbeat main owned went on renewing itself for a page that no longer
  // existed and Transcribe, Create and Delete were refused for ever over a
  // recording nobody was making. Here the page says it is going, and that is the
  // whole of the mechanism.
  assert.deepEqual(supervisor.releaseWindow('wr-first'), [session.id]);
  assert.deepEqual(await supervisor.writing(), []);
  assert.equal(supervisor.isWriting(session.id), false);

  // Reporting it twice is not an error — the page's own `pagehide` and main's
  // `destroyed` hook both fire for an ordinary window close.
  assert.deepEqual(supervisor.releaseWindow('wr-first'), []);

  // …and the reloaded window, which is a NEW writer with a new id, gets the
  // meeting back: it is an ordinary unfinished recording now.
  const reloaded = await supervisor.adopt(session.id, 'wr-reloaded');
  assert.equal(reloaded.segments.length, 1);
  await supervisor.close(session.id, 'discard', 'wr-reloaded');
  assert.equal(fs.existsSync(captureDirectory(home, session.id)), false);
  assert.deepEqual(await store.resumable(), []);
});

test('a window going away releases ITS captures and nobody else\'s', async () => {
  const { supervisor } = harness(async () => 'text');
  const mine = await supervisor.begin({ scope: { orgId: null }, title: 'Mine', writerId: 'wr-first' });
  const theirs = await supervisor.begin({ scope: { orgId: null }, title: 'Theirs', writerId: 'wr-second' });

  // `openWorkspaceWindow` mints one window per workspace inside ONE Electron
  // process, so two live recordings in this map is the ordinary case rather than
  // an exotic one. A release that ignored the id it was given would answer a
  // reload of either window by handing BOTH recordings back: the surviving one
  // would drop out of its own writers panel, rejoin every other window's offer
  // with an enabled Delete beside it, and stop being refused to anyone — while
  // its microphone was still open.
  assert.deepEqual(supervisor.releaseWindow('wr-first'), [mine.id]);

  assert.equal(supervisor.isWriting(mine.id), false);
  assert.equal(supervisor.isWriting(theirs.id), true);
  assert.deepEqual(await supervisor.writing(), [
    { sessionId: theirs.id, holderId: 'wr-second', note: MEETING_CAPTURE_WRITER_NOTE },
  ]);
  // …and the recording that survived is still refused to everyone else.
  await assert.rejects(() => supervisor.close(theirs.id, 'discard', 'wr-first'), /recording this meeting right now/);
});

test('picking a capture up claims nothing, because a pick-up is not a recording', async () => {
  const { store, supervisor } = harness(async () => 'text');
  const session = await supervisor.begin({ scope: { orgId: null }, title: 'Interrupted', writerId: 'wr-first' });
  await supervisor.append(session.id, new Uint8Array([1, 2]), 20_000);
  await supervisor.settle(session.id);
  // The window that recorded it is gone — a reload, a close, a crash — so this
  // is an ordinary unfinished recording again.
  supervisor.releaseWindow('wr-first');

  await supervisor.adopt(session.id, 'wr-second');

  // Nobody is producing audio for this capture, so nothing may claim otherwise.
  // A writer registered here would contradict the one thing this map means, and
  // it would be permanent: none of the four removals — Stop, close, the window
  // going away, a failed Record — is reached by a pick-up, so the capture would
  // be hidden from every window's offer and refused to every other window for
  // the rest of the process's life, having been transcribed perfectly.
  assert.equal(supervisor.isWriting(session.id), false);
  assert.deepEqual(await supervisor.writing(), []);
  assert.deepEqual((await store.resumable()).map((row) => row.sessionId), [session.id]);
  // …including the window that picked it up, which must be able to finish it.
  await supervisor.close(session.id, 'finalize', 'wr-second');
});

test('Stop waits for the chunk that is still landing before it commits', async () => {
  const { store, supervisor } = harness(async (bytes) => `chunk-${bytes.byteLength}`);
  const session = await supervisor.begin({ scope: { orgId: null }, title: 'Stopped mid-write' });
  // The last chunk, held between the recorder handing it over and the disk
  // taking it — which is exactly where Stop lands, because `MediaRecorder`
  // flushes a final blob and the write behind it is IPC plus a file.
  let landed = (): void => undefined;
  const inFlight = new Promise<void>((resolve) => { landed = resolve; });
  const write = store.writeSegment.bind(store);
  store.writeSegment = async (id, index, bytes) => { await inFlight; return await write(id, index, bytes); };

  const appending = supervisor.append(session.id, new Uint8Array([1, 2, 3]), 20_000);
  const stopping = supervisor.stop(session.id);
  landed();
  const stopped = await stopping;
  await appending;

  // Without the wait, Stop commits `stopCapture` over a session with no segments
  // and the append that follows is refused — the shared model will not extend a
  // capture that is already stopped. The meeting's last chunk is on disk and in
  // no record: no text, no gap marker, nothing to retry from, and the recovery
  // card advertising a byte count for audio the session never claimed.
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(stopped.segments.map((segment) => segment.byteLength), [3]);
  await supervisor.settle(session.id);
  assert.deepEqual((await record(store, session.id)).segments.map((segment) => segment.text), ['chunk-3']);
});

test('an anonymous Record claims nothing, and blocks nobody', async () => {
  const { supervisor } = harness(async () => 'text');
  // The caller would not say who it was, so there is nothing for another window
  // to be told about — and nothing for it to be refused over either. Treating an
  // absent id as a claim nobody could ever match would make the capture
  // permanently undeletable, which is the failure this round removed.
  const session = await supervisor.begin({ scope: { orgId: null } });
  assert.deepEqual(await supervisor.writing(), []);
  await supervisor.close(session.id, 'discard', 'wr-anyone');
});
