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
import { MeetingEndpointUnavailableError, MEETING_GAP_PHRASE, transcriptText } from '@kinqs/brainrouter-core/meetings';
import { MeetingCaptureStore, MEETING_CAPTURE_DIRECTORY } from './meetingCapture.js';
import { MeetingTranscriptionSupervisor, type MeetingCaptureProgress } from './meetingTranscription.js';

function userData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-meeting-queue-'));
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
    schedule: (run, delayMs) => { wakes.push({ run, delayMs }); return () => undefined; },
    now: () => clock.nowMs,
  });
  return {
    home,
    store,
    supervisor,
    requests,
    published,
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
  const stored = await store.session(session.id);
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
  const during = await store.session(session.id);
  assert.equal(during.segments[0]?.state, 'pending');
  assert.equal(during.segments[0]?.attempts, 0);

  down = false;
  await runWakes();
  await supervisor.settle(session.id);

  assert.equal((await store.session(session.id)).segments[0]?.text, 'recovered');
  assert.ok(requests.length >= 2);
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

  const failed = await store.session(session.id);
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
  assert.equal(transcriptText(await store.session(session.id)), 'filled in');
});

test('a new process finishes the segments the last one left behind', async () => {
  const first = harness(async () => { throw new MeetingEndpointUnavailableError(); });
  const session = await first.supervisor.begin({ scope: { orgId: null }, title: 'Interrupted' });
  await first.supervisor.append(session.id, new Uint8Array([1, 2]), 20_000);
  await first.supervisor.append(session.id, new Uint8Array([3, 4]), 20_000);
  await first.supervisor.settle(session.id);
  assert.deepEqual((await first.store.session(session.id)).segments.map((segment) => segment.state), ['pending', 'pending']);

  // The app is killed here. A new launch runs the boot pass and a NEW supervisor
  // over the same directory — the queue is restartable because it holds no work
  // list, only the record on disk.
  const { store, supervisor, requests } = harness(async (bytes) => `after-restart-${bytes.byteLength}`, first.home);
  await store.recoverInterrupted();

  await supervisor.adopt(session.id);
  await supervisor.settle(session.id);

  assert.deepEqual(requests, [2, 2]);
  assert.equal(transcriptText(await store.session(session.id)), 'after-restart-2\nafter-restart-2');
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
