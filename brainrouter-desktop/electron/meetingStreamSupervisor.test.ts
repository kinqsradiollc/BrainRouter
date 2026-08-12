/**
 * ADR-035 D10 — what the desktop has to be true about once an endpoint offers a
 * live stream, asserted end to end: a real capture directory on disk, the real
 * supervisor and queue, and a fake endpoint at the one seam that would otherwise
 * need a network.
 *
 * The ADR names four things this must show, and each is a test below:
 *
 * - **Text appears WHILE a sentence is being spoken.** Not after the utterance,
 *   and not after the unit — asserted as a partial reaching the renderer's
 *   channel while the record still has no segments at all.
 * - **A checkpoint is promoted only after the matching transcript state is
 *   persisted.** Asserted by failing the write and watching the next connection
 *   ask to resume from the earlier point, replaying audio that is still on disk.
 * - **The fallback is visible and says why** (golden rule 23). Asserted as the
 *   sentence on the wire, for an endpoint that offers no stream and for one that
 *   drops mid-meeting.
 * - **Durability does not move** (D1). Asserted as: at the instant a chunk is
 *   handed to the endpoint, its bytes are already a file in the capture
 *   directory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createStreamingTranscriptionCapabilities,
  transcriptText,
  SEGMENTED_TRANSCRIPTION_CAPABILITIES,
  type MeetingCaptureSession,
} from '@kinqs/brainrouter-core/meetings';
import { MeetingCaptureStore, MEETING_CAPTURE_DIRECTORY } from './meetingCapture.js';
import type { MeetingStreamConnection } from './meetingStreamConnection.js';
import { MeetingStreamUnavailableError } from './meetingStreamProtocol.js';
import type { MeetingStreamPortOpenInput, MeetingTranscriptionStreamPort } from './meetingStreamSession.js';
import { MeetingTranscriptionSupervisor, type MeetingCaptureProgress } from './meetingTranscription.js';

/** One chunk's worth of audio. The bytes never matter here; the ledger entry and the file do. */
function chunk(size = 4): Uint8Array {
  return new Uint8Array(size).fill(1);
}

/**
 * A first chunk shaped like what `MediaRecorder` really hands over: a container
 * prologue, then the first media cluster. Six bytes of header, so a test can
 * tell "the bootstrap was sent" from "an empty frame was sent".
 */
const CONTAINER_HEADER = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42];

function firstChunk(): Uint8Array {
  return Uint8Array.from([...CONTAINER_HEADER, 0x1f, 0x43, 0xb6, 0x75, 1, 2, 3]);
}

function userData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-meeting-stream-'));
}

function captureFiles(home: string, id: string): string[] {
  return fs.readdirSync(path.join(home, MEETING_CAPTURE_DIRECTORY, id)).filter((entry) => entry.endsWith('.webm'));
}

/** The bytes the store has actually written for one durability chunk, read straight off the filesystem. */
function chunkFileBytes(home: string, id: string, sequence: number): number {
  const file = path.join(home, MEETING_CAPTURE_DIRECTORY, id, `segment-${String(sequence).padStart(5, '0')}.webm`);
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Poll rather than sleep: the send pacing and the event chain are asynchronous by design. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

interface SentChunk {
  readonly connection: number;
  readonly sequence: number;
  readonly startMs: number;
  readonly endMs: number;
  /** The size of THIS chunk's file at the instant it was handed to the endpoint (D1). Zero when it did not exist. */
  readonly bytesOnDisk: number;
}

interface FakeConnection {
  readonly index: number;
  readonly input: MeetingStreamPortOpenInput;
  readonly initialization: Uint8Array;
  /** True once the host has asked for the tail. A real endpoint answers AFTER emitting it. */
  finishRequested: boolean;
  emit(event: unknown): void;
  /** What `{"type":"finished"}` does on a real connection: resolve the finish the host is waiting on. */
  completeFinish(): void;
  drop(code: 'endpoint' | 'audio' | 'refused'): void;
}

class FakeEndpoint {
  readonly opens: MeetingStreamPortOpenInput[] = [];
  readonly sent: SentChunk[] = [];
  readonly connections: FakeConnection[] = [];
  /** Set to reject the next `open`, the way a signed-out desktop or a refused upgrade does. */
  refusal: Error | null = null;

  constructor(
    private readonly advertised: unknown,
    private readonly bytesOnDisk: (sequence: number) => number,
  ) {}

  get port(): MeetingTranscriptionStreamPort {
    return {
      capabilities: async () => this.advertised,
      open: async (input) => this.#open(input),
    };
  }

  #open(input: MeetingStreamPortOpenInput): MeetingStreamConnection {
    this.opens.push(input);
    if (this.refusal) {
      const refusal = this.refusal;
      this.refusal = null;
      throw refusal;
    }
    const index = this.connections.length;
    let settle: (kind: 'endpoint' | 'audio' | 'refused' | 'finished') => void = () => undefined;
    const closed = new Promise<'endpoint' | 'audio' | 'refused' | 'finished'>((resolve) => { settle = resolve; });
    // An honest adapter accepts exactly the checkpoint the host proved, never a
    // higher one — which is what the gateway enforces on a real one.
    const accepted = input.resumeFromSequence;
    let completeFinish: () => void = () => undefined;
    const finishing = new Promise<void>((resolve) => { completeFinish = resolve; });
    const state: FakeConnection = {
      index,
      input,
      initialization: input.initializationSegmentFor(accepted),
      finishRequested: false,
      emit: (event) => { input.handlers.onEvent(event); },
      completeFinish: () => { completeFinish(); },
      drop: (kind) => { settle(kind); },
    };
    this.connections.push(state);
    return {
      acceptedResumeFromSequence: accepted,
      latencyMode: input.latencyMode,
      send: (audioChunk) => {
        this.sent.push({
          connection: index,
          sequence: audioChunk.sequence,
          startMs: audioChunk.startMs,
          endMs: audioChunk.endMs,
          bytesOnDisk: this.bytesOnDisk(audioChunk.sequence),
        });
      },
      // The real one resolves on `{"type":"finished"}`, which the endpoint sends
      // AFTER the tail's events — so a fake that resolved immediately would test
      // an ordering production does not have.
      finish: async () => { state.finishRequested = true; await finishing; },
      close: () => { settle('finished'); },
      closed,
    };
  }
}

interface Harness {
  readonly home: string;
  readonly store: MeetingCaptureStore;
  readonly supervisor: MeetingTranscriptionSupervisor;
  readonly endpoint: FakeEndpoint;
  readonly published: MeetingCaptureProgress[];
  /** Every batch transcription request that reached the segmented path. */
  readonly requests: number[];
  /** Backoffs the supervisor has asked to be woken after but that have not run. */
  wakeCount(): number;
  runWakes(): Promise<void>;
}

function harness(advertised: unknown, transcribe: (bytes: Uint8Array) => Promise<string> = async (bytes) => `batch-${bytes.byteLength}`): Harness {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const published: MeetingCaptureProgress[] = [];
  const requests: number[] = [];
  const wakes: Array<{ run: () => void; delayMs: number }> = [];
  let captureId = '';
  const endpoint = new FakeEndpoint(advertised, (sequence) => (captureId ? chunkFileBytes(home, captureId, sequence) : 0));
  const supervisor = new MeetingTranscriptionSupervisor(store, {
    transcribe: async ({ bytes }) => {
      requests.push(bytes.byteLength);
      return await transcribe(bytes);
    },
    streaming: endpoint.port,
    publish: (progress) => {
      captureId = progress.sessionId;
      published.push(progress);
    },
    schedule: (run, delayMs) => { wakes.push({ run, delayMs }); return () => undefined; },
  });
  return {
    home,
    store,
    supervisor,
    endpoint,
    published,
    requests,
    wakeCount: () => wakes.length,
    async runWakes() {
      for (const wake of wakes.splice(0, wakes.length)) {
        wake.run();
        await Promise.resolve();
      }
    },
  };
}

const STREAMING = createStreamingTranscriptionCapabilities(['low-latency', 'balanced']);

async function record(store: MeetingCaptureStore, id: string): Promise<MeetingCaptureSession> {
  return (await store.stored(id)).session;
}

test('an endpoint that offers no stream leaves the segmented path exactly as it was, and says so', async () => {
  const { store, supervisor, endpoint, published, requests } = harness(SEGMENTED_TRANSCRIPTION_CAPABILITIES);
  const session = await supervisor.begin({ scope: { orgId: 'org_1' }, title: 'Segmented' });

  await supervisor.append(session.id, chunk(2), 20_000);
  await supervisor.append(session.id, chunk(3), 20_000);
  await supervisor.settle(session.id);

  // Production today. Nothing is opened, and the unit cadence is the segmented
  // one — the 20-second default, not the streaming ceiling.
  assert.deepEqual(endpoint.opens, []);
  assert.deepEqual(requests, [2, 3]);
  const stored = await record(store, session.id);
  assert.deepEqual(stored.segments.map((segment) => segment.state), ['done', 'done']);

  // Golden rule 23 — and the surface is TOLD which path it got.
  const status = published.map((progress) => progress.transcription).find(Boolean);
  assert.equal(status?.mode, 'segmented');
  assert.equal(status?.live, false);
  assert.match(status?.notice ?? '', /transcribed in segments/i);
});

test('text appears while the sentence is still being spoken, before any segment exists', async () => {
  const { store, supervisor, endpoint, published } = harness(STREAMING);
  const session = await supervisor.begin({ scope: { orgId: 'org_1' }, title: 'Live' });
  await supervisor.append(session.id, chunk(), 3_000);
  await until(() => endpoint.connections.length === 1, 'the live connection to open');

  endpoint.connections[0]!.emit({ kind: 'partial', utteranceId: 'u0', revision: 0, text: 'we should', startMs: 0, endMs: 1_800 });
  await until(
    () => published.some((progress) => progress.live?.some((utterance) => utterance.text === 'we should')),
    'the partial to reach the renderer channel',
  );

  const push = published.filter((progress) => progress.live?.length).at(-1)!;
  const utterance = push.live![0]!;
  // D4 — provisional, and marked as such. If the first text for an utterance
  // only arrived once the utterance was over, D10 did not land.
  assert.equal(utterance.state, 'partial');
  assert.equal(utterance.endMs, 1_800);
  // …and it is NOT in the record. The compose box only ever gets settled text.
  assert.deepEqual(push.session.segments, []);
  assert.deepEqual((await record(store, session.id)).segments, []);
  assert.equal(push.transcription?.mode, 'streaming');
  assert.equal(push.transcription?.live, true);
});

test('a revision replaces the partial in place and a coverage proof settles it on disk', async () => {
  const { store, supervisor, endpoint, published } = harness(STREAMING);
  const session = await supervisor.begin({ scope: { orgId: 'org_1' }, title: 'Live' });
  await supervisor.append(session.id, chunk(), 3_000);
  await until(() => endpoint.connections.length === 1, 'the live connection to open');
  const live = endpoint.connections[0]!;

  live.emit({ kind: 'partial', utteranceId: 'u0', revision: 0, text: 'we should', startMs: 0, endMs: 1_800 });
  live.emit({ kind: 'partial', utteranceId: 'u0', revision: 1, text: 'we should ship', startMs: 0, endMs: 2_400 });
  await until(
    () => published.some((progress) => progress.live?.some((utterance) => utterance.text === 'we should ship')),
    'the revised partial',
  );
  // One utterance, revised — not two rows saying the same sentence twice.
  assert.equal(published.filter((progress) => progress.live?.length).at(-1)!.live!.length, 1);

  live.emit({ kind: 'final', utteranceId: 'u0', revision: 2, text: 'We should ship it.', startMs: 0, endMs: 2_800 });
  live.emit({ kind: 'coverage', coveredThroughSequence: 0 });
  await until(
    () => published.some((progress) => progress.session.segments[0]?.state === 'done'),
    'the covered chunk to be sealed and settled',
  );

  const stored = await record(store, session.id);
  // The words are ON DISK, in a unit whose range is the covered chunk's, and the
  // shared transcript reads them exactly once.
  assert.deepEqual(stored.segments.map((segment) => [segment.state, segment.text]), [['done', 'We should ship it.']]);
  assert.deepEqual(stored.segments[0]?.chunks, [0]);
  assert.equal(stored.segments[0]?.startMs, 0);
  assert.equal(stored.segments[0]?.endMs, 3_000);
  assert.equal(transcriptText(stored), 'We should ship it.');
  // …and it has left the provisional list, so the same words are not on screen
  // twice in two different states.
  assert.deepEqual(published.at(-1)?.live, []);
});

test('a chunk reaches the endpoint only after its bytes are a file in the capture directory', async () => {
  const { home, supervisor, endpoint } = harness(STREAMING);
  const session = await supervisor.begin({ scope: { orgId: 'org_1' }, title: 'Durable first' });

  await supervisor.append(session.id, chunk(), 3_000);
  await supervisor.append(session.id, chunk(), 3_000);
  await until(() => endpoint.sent.length === 2, 'both chunks to be sent');

  // D1 — the whole ordering of this ADR, measured rather than asserted in prose:
  // at the instant chunk N is handed to the endpoint, chunk N's own bytes are
  // already a file. Offering before the write makes this zero.
  assert.deepEqual(endpoint.sent.map((entry) => entry.sequence), [0, 1]);
  assert.deepEqual(endpoint.sent.map((entry) => entry.bytesOnDisk), [4, 4]);
  assert.deepEqual(endpoint.sent.map((entry) => [entry.startMs, entry.endMs]), [[0, 3_000], [3_000, 6_000]]);
  assert.equal(captureFiles(home, session.id).length, 2);
});

test('a chunk offered before the capability answer arrives is still sent once it does', async () => {
  let answer: (value: unknown) => void = () => undefined;
  const advertised = new Promise<unknown>((resolve) => { answer = resolve; });
  const { supervisor, endpoint } = harness(advertised);
  const session = await supervisor.begin({ scope: { orgId: 'org_1' }, title: 'Slow probe' });

  // The probe is still in flight, so the mode is still the segmented default.
  // The chunk is durable regardless — D1 does not wait for the network — and it
  // must be remembered rather than dropped for having been early.
  await supervisor.append(session.id, chunk(), 3_000);
  assert.equal(endpoint.sent.length, 0);

  answer(STREAMING);
  await until(() => endpoint.sent.length === 1, 'the early chunk to be sent after the answer');
  assert.equal(endpoint.sent[0]?.sequence, 0);
});

test('the first connection sends no container header, because chunk 0 carries its own', async () => {
  const { supervisor, endpoint } = harness(STREAMING);
  const session = await supervisor.begin({ scope: { orgId: 'org_1' }, title: 'Header' });
  // A real prologue is on disk, and it still must NOT be prepended here:
  // prepending it would put the recording's first bytes into the decode twice,
  // which is the mistake `segmentAudio.ts` avoids on the batch path.
  await supervisor.append(session.id, firstChunk(), 3_000);
  await until(() => endpoint.connections.length === 1, 'the live connection to open');

  assert.equal(endpoint.opens[0]?.resumeFromSequence, null);
  assert.equal(endpoint.connections[0]?.initialization.byteLength, 0);
});

test('a dropped connection replays from the persisted checkpoint, out of audio still on disk', async () => {
  const { store, supervisor, endpoint, published, runWakes, wakeCount } = harness(STREAMING);
  const session = await supervisor.begin({ scope: { orgId: 'org_1' }, title: 'Reconnect' });
  await supervisor.append(session.id, firstChunk(), 3_000);
  for (let index = 0; index < 2; index += 1) await supervisor.append(session.id, chunk(), 3_000);
  await until(() => endpoint.sent.length === 3, 'three chunks to be sent');

  const live = endpoint.connections[0]!;
  live.emit({ kind: 'final', utteranceId: 'u0', revision: 0, text: 'first', startMs: 0, endMs: 2_800 });
  live.emit({ kind: 'coverage', coveredThroughSequence: 0 });
  // The commit has to LAND before the drop, or this would be asserting the
  // uncommitted case that the next test covers.
  await until(
    () => published.some((progress) => progress.session.segments.some((unit) => unit.state === 'done')),
    'chunk 0 to be committed',
  );
  const committedUnit = (await record(store, session.id)).segments[0];
  assert.equal(committedUnit?.text, 'first');
  // Only what the coverage PROVED. Sealing the whole open run here would commit
  // words for audio the endpoint never said it had finished with.
  assert.deepEqual(committedUnit?.chunks, [0]);

  live.drop('endpoint');
  await until(() => wakeCount() > 0, 'the reconnect backoff to be scheduled');
  await runWakes();
  await until(() => endpoint.connections.length === 2, 'the reconnect');

  // Resumed at the checkpoint the host PERSISTED, and everything after it is
  // sent again from the disk — which is why a dropped connection costs a
  // reconnect and not a meeting.
  assert.equal(endpoint.opens[1]?.resumeFromSequence, 0);
  // Resuming past chunk 0 means the far side is a FRESH decode with no header in
  // front of it, so this connection carries the bootstrap the first one did not
  // need — read back off the disk, like everything else here.
  assert.deepEqual([...(endpoint.connections[1]?.initialization ?? [])], CONTAINER_HEADER);
  await until(() => endpoint.sent.filter((entry) => entry.connection === 1).length === 2, 'the replay');
  assert.deepEqual(endpoint.sent.filter((entry) => entry.connection === 1).map((entry) => entry.sequence), [1, 2]);

  // ADR-028/golden rule 28 — and the sentence follows the state BACK. A stream
  // that recovered while the panel still reads "being picked up again" is a
  // claim the code no longer has, which is the same defect as a spinner over a
  // segment that failed twenty minutes ago.
  const restored = published.map((progress) => progress.transcription).filter(Boolean).at(-1)!;
  assert.equal(restored.mode, 'streaming');
  assert.equal(restored.live, true);
  assert.match(restored.notice, /Live transcription is on/);
});

test('an endpoint that keeps dropping stops being reconnected to, and the surface is told', async () => {
  const { supervisor, endpoint, published, runWakes, wakeCount } = harness(STREAMING);
  const session = await supervisor.begin({ scope: { orgId: 'org_1' }, title: 'Flapping' });
  await supervisor.append(session.id, chunk(), 3_000);
  await until(() => endpoint.connections.length === 1, 'the live connection to open');

  // A connection that accepts and immediately drops, over and over. It never
  // covers anything, so it never earns its budget back — the bound has to be on
  // the RECONNECTS, or a flapping endpoint is an infinite loop with a sentence
  // on screen that says everything is fine.
  const degraded = (): boolean => published.some((progress) => progress.transcription?.mode === 'segmented');
  for (let attempt = 0; attempt < 6 && !degraded(); attempt += 1) {
    const before = endpoint.connections.length;
    endpoint.connections.at(-1)!.drop('endpoint');
    // Either a backoff was scheduled or the budget ran out; both are answers,
    // and waiting for only the first one would hang on the very case this test
    // is about.
    await until(() => wakeCount() > 0 || degraded(), 'the backoff or the give-up');
    if (degraded()) break;
    await runWakes();
    await until(() => endpoint.connections.length > before || degraded(), 'the reconnect or the give-up');
  }

  const status = published.map((progress) => progress.transcription).filter(Boolean).at(-1)!;
  assert.equal(status.mode, 'segmented');
  assert.match(status.notice, /transcribed in segments/i);
  // Four reconnects and no more: the fifth answer is the segmented path, which
  // is already draining every unit the ceiling seals.
  assert.equal(endpoint.connections.length, 5);
});

test('a checkpoint is not promoted when the transcript state failed to persist', async () => {
  const { store, supervisor, endpoint, runWakes, wakeCount } = harness(STREAMING);
  const session = await supervisor.begin({ scope: { orgId: 'org_1' }, title: 'Write fails' });
  for (let index = 0; index < 2; index += 1) await supervisor.append(session.id, chunk(), 3_000);
  await until(() => endpoint.sent.length === 2, 'both chunks to be sent');

  // The write that would have made the coverage real fails. The ADR's rule is
  // that the checkpoint only becomes resume authority AFTER this succeeds.
  const original = store.persist.bind(store);
  let failing = true;
  (store as unknown as { persist: MeetingCaptureStore['persist'] }).persist = async (next) => {
    if (failing) throw new Error('disk full');
    return await original(next);
  };

  const live = endpoint.connections[0]!;
  live.emit({ kind: 'final', utteranceId: 'u0', revision: 0, text: 'lost', startMs: 0, endMs: 2_800 });
  live.emit({ kind: 'coverage', coveredThroughSequence: 0 });
  await new Promise((resolve) => { setTimeout(resolve, 40); });
  failing = false;

  live.drop('endpoint');
  await until(() => wakeCount() > 0, 'the reconnect backoff to be scheduled');
  await runWakes();
  await until(() => endpoint.connections.length === 2, 'the reconnect');

  // Null, not 0: the transcript for chunk 0 never reached the disk, so resuming
  // past it would be audio whose words exist nowhere. It is replayed instead.
  assert.equal(endpoint.opens[1]?.resumeFromSequence, null);
  await until(() => endpoint.sent.filter((entry) => entry.connection === 1).length === 2, 'the full replay');
  assert.deepEqual(endpoint.sent.filter((entry) => entry.connection === 1).map((entry) => entry.sequence), [0, 1]);
});

test('audio the endpoint cannot decode ends the live path visibly, and never reconnects over it', async () => {
  const { supervisor, endpoint, published, runWakes } = harness(STREAMING);
  const session = await supervisor.begin({ scope: { orgId: 'org_1' }, title: 'Undecodable' });
  await supervisor.append(session.id, chunk(), 3_000);
  await until(() => endpoint.connections.length === 1, 'the live connection to open');

  endpoint.connections[0]!.drop('audio');
  await until(
    () => published.some((progress) => progress.transcription?.mode === 'segmented'),
    'the visible degradation',
  );
  await runWakes();

  const status = published.map((progress) => progress.transcription).filter(Boolean).at(-1)!;
  assert.equal(status.mode, 'segmented');
  assert.equal(status.live, false);
  assert.match(status.notice, /could not decode/i);
  // D7 — bad bytes are not an outage, so this is not retried. Reconnecting here
  // would replay audio that will never decode for as long as the meeting lasts.
  assert.equal(endpoint.connections.length, 1);
});

test('a refusal that will refuse again says why instead of retrying four times', async () => {
  const { supervisor, endpoint, published } = harness(STREAMING);
  endpoint.refusal = new MeetingStreamUnavailableError('Live transcription needs a signed-in BrainRouter account, so this meeting is being transcribed in segments.');
  const session = await supervisor.begin({ scope: { orgId: 'org_1' }, title: 'Signed out' });
  await supervisor.append(session.id, chunk(), 3_000);
  await until(
    () => published.some((progress) => progress.transcription?.mode === 'segmented'),
    'the visible degradation',
  );

  const status = published.map((progress) => progress.transcription).filter(Boolean).at(-1)!;
  assert.match(status.notice, /signed-in BrainRouter account/);
  assert.equal(endpoint.opens.length, 1);
});

test('a stream that stops covering leaves the chunks to the segmented path, and never doubles the text', async () => {
  const { store, supervisor, endpoint, requests } = harness(STREAMING);
  const session = await supervisor.begin({ scope: { orgId: 'org_1' }, title: 'Ceiling' });
  // Past the streaming strategy's hard ceiling with no coverage at all: the
  // meeting must still become text, which is what the ceiling is for.
  for (let index = 0; index < 3; index += 1) await supervisor.append(session.id, chunk(), 20_000);
  await supervisor.settle(session.id);
  await until(() => requests.length === 1, 'the ceiling unit to be transcribed in segments');

  const sealed = await record(store, session.id);
  // The ceiling cuts BEFORE the breach, so the unit is the run that fitted.
  assert.equal(sealed.segments.length, 1);
  assert.deepEqual(sealed.segments[0]?.chunks, [0, 1]);
  assert.equal(sealed.segments[0]?.state, 'done');
  const batched = sealed.segments[0]?.text;
  assert.equal(batched, 'batch-8');

  // Now the endpoint finally claims coverage over the SAME chunks. A unit
  // already claimed them, so this seals nothing and commits nothing — the two
  // strategies cannot both put words in one stretch of the meeting.
  const live = endpoint.connections[0]!;
  live.emit({ kind: 'final', utteranceId: 'u0', revision: 0, text: 'streamed words', startMs: 0, endMs: 39_000 });
  live.emit({ kind: 'coverage', coveredThroughSequence: 1 });
  await new Promise((resolve) => { setTimeout(resolve, 50); });

  const after = await record(store, session.id);
  assert.equal(after.segments.length, 1);
  assert.equal(after.segments[0]?.text, batched);
  assert.equal(transcriptText(after).includes('streamed words'), false);
});

test('Stop asks the endpoint for the tail before the remainder is sealed for the segmented queue', async () => {
  const { store, supervisor, endpoint } = harness(STREAMING);
  const session = await supervisor.begin({ scope: { orgId: 'org_1' }, title: 'Tail' });
  await supervisor.append(session.id, chunk(), 3_000);
  await until(() => endpoint.sent.length === 1, 'the chunk to be sent');

  const live = endpoint.connections[0]!;
  // The sidecar seals the tail a moment after Stop; the host has to be still
  // listening, or the last utterance is a segmented re-transcription.
  const stopping = supervisor.stop(session.id);
  await until(() => live.finishRequested, 'the finish frame');
  live.emit({ kind: 'final', utteranceId: 'u0', revision: 0, text: 'and that is it.', startMs: 0, endMs: 2_900 });
  live.emit({ kind: 'coverage', coveredThroughSequence: 0 });
  live.completeFinish();
  await stopping;

  const stored = await record(store, session.id);
  assert.equal(stored.status, 'stopped');
  assert.deepEqual(stored.segments.map((segment) => [segment.state, segment.text]), [['done', 'and that is it.']]);
  assert.equal(transcriptText(stored), 'and that is it.');
});

test('a killed streaming capture still recovers: the chunks are on disk and a new supervisor finishes them', async () => {
  const { home, store, supervisor, endpoint } = harness(STREAMING);
  const session = await supervisor.begin({ scope: { orgId: 'org_1' }, title: 'Killed' });
  for (let index = 0; index < 2; index += 1) await supervisor.append(session.id, chunk(), 3_000);
  await until(() => endpoint.sent.length === 2, 'both chunks to be sent');
  // §6 — killed, not stopped. Nothing is finished, nothing is covered, and the
  // record still says `recording`.
  supervisor.dispose();

  assert.equal(captureFiles(home, session.id).length, 2);
  const survivor = new MeetingCaptureStore(home);
  const requests: number[] = [];
  const reopened = new MeetingTranscriptionSupervisor(survivor, {
    transcribe: async ({ bytes }) => { requests.push(bytes.byteLength); return 'recovered'; },
    schedule: (_run, _delayMs) => () => undefined,
  });
  await survivor.recoverInterrupted({});
  await reopened.adopt(session.id);
  await reopened.settle(session.id);

  const stored = await record(survivor, session.id);
  assert.equal(stored.status, 'stopped');
  assert.equal(requests.length, 1);
  assert.equal(transcriptText(stored), 'recovered');
  assert.equal(stored.segments.every((segment) => segment.state === 'done'), true);
});

test('a reconnect does not write the replayed sentence twice', async () => {
  const { store, supervisor, endpoint, runWakes, wakeCount } = harness(STREAMING);
  const session = await supervisor.begin({ scope: { orgId: 'org_1' }, title: 'Replay' });
  await supervisor.append(session.id, firstChunk(), 3_000);
  for (let index = 0; index < 2; index += 1) await supervisor.append(session.id, chunk(), 3_000);
  await until(() => endpoint.sent.length === 3, 'three chunks to be sent');

  // A final the endpoint produced but never PROVED — no coverage reaches it, so
  // it is still in the live buffer when the socket dies. That is the ordinary
  // shape of a blip: the words exist, the proof does not.
  const first = endpoint.connections[0]!;
  first.emit({ kind: 'final', utteranceId: 'gen0-u1', revision: 0, text: 'the same sentence', startMs: 3_000, endMs: 5_800 });
  first.drop('endpoint');

  await until(() => wakeCount() > 0, 'the reconnect backoff');
  await runWakes();
  await until(() => endpoint.connections.length === 2, 'the reconnect');

  // The replacement re-decodes the replayed audio and says the same words. Its
  // utterance id differs because the adapter namespaces ids by connection
  // generation, so nothing downstream can tell the two copies apart by id — the
  // live buffer has to have been reset instead.
  const second = endpoint.connections[1]!;
  second.emit({ kind: 'final', utteranceId: 'gen1-u1', revision: 0, text: 'the same sentence', startMs: 3_000, endMs: 5_800 });
  second.emit({ kind: 'coverage', coveredThroughSequence: 1 });

  let committedText = '';
  await until(() => {
    void record(store, session.id).then((current) => {
      committedText = current.segments
        .filter((unit) => unit.state === 'done')
        .map((unit) => unit.text ?? '')
        .join(' ');
    });
    return committedText.length > 0;
  }, 'the covered unit to be committed');

  const committed = (await record(store, session.id)).segments
    .filter((unit) => unit.state === 'done')
    .map((unit) => unit.text ?? '')
    .join(' ');
  const occurrences = committed.split('the same sentence').length - 1;
  assert.equal(occurrences, 1, `the replayed sentence is in the transcript ${occurrences} times: ${committed}`);
});
