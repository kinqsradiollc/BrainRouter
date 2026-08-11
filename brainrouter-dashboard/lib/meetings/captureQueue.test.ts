/**
 * ADR-035 D3/D5/D7 — the dashboard's ports, driven by the REAL shared queue.
 *
 * Nothing here mocks the scheduler. The point of these tests is the seam: the
 * queue is the shared one, and what is being checked is that this host's three
 * ports hand it what it expects — one segment's audio with its container header
 * back in front of it, a failure that carries its HTTP status so D7's
 * outage-versus-rejection distinction still works, and a persist that writes the
 * whole session where the next load will find it.
 *
 * They run against the real `MeetingCaptureStore` over the in-memory backend
 * fixture, so the chunk that gets read is a chunk that was actually written.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  appendSegment,
  createCaptureSession,
  transcriptGaps,
  type MeetingCaptureSession,
} from "@kinqs/brainrouter-core/meetings";

import { audioBlob, FakeCaptureBackend } from "./_captureBackendFixture";
import { parseCapturePayload } from "./capturePayload";
import { createCaptureQueue, SegmentTranscriptionError, type SegmentTranscriber } from "./captureQueue";
import { MeetingCaptureStore } from "./captureStore";

const SESSION_ID = "mtg-1";
/** A first chunk shaped like real MediaRecorder output: header, then a cluster. */
const HEADER = [0xaa, 0xaa, 0xaa, 0xaa];
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75];

function firstChunk(): Blob {
  return new Blob([Uint8Array.from([...HEADER, ...CLUSTER, 0x01])]);
}

function laterChunk(marker: number): Blob {
  return new Blob([Uint8Array.from([...CLUSTER, marker])]);
}

async function seed(store: MeetingCaptureStore, blobs: readonly Blob[]): Promise<MeetingCaptureSession> {
  await store.begin({ sessionId: SESSION_ID, startedAt: "2026-08-10T09:00:00.000Z" });
  let session = createCaptureSession({
    id: SESSION_ID,
    scope: { orgId: null },
    startedAt: "2026-08-10T09:00:00.000Z",
  });
  for (const blob of blobs) {
    const chunk = await store.appendChunk(SESSION_ID, blob);
    session = appendSegment(session, { byteLength: chunk.byteLength, durationMs: 20_000 });
  }
  return session;
}

function recording(transcribe: SegmentTranscriber, store = new MeetingCaptureStore(new FakeCaptureBackend())) {
  return { store, transcribe };
}

test("every segment is transcribed, and each request carries only its own audio", async () => {
  const posted: number[][] = [];
  const { store, transcribe } = recording(async (audio) => {
    posted.push([...audio]);
    return `part ${posted.length}`;
  });
  const session = await seed(store, [firstChunk(), laterChunk(0x11), laterChunk(0x22)]);
  const queue = createCaptureQueue({ store, session, transcribe });

  const result = await queue.drain();

  assert.equal(result.phase, "idle");
  assert.deepEqual([...result.transcribed].sort((a, b) => a - b), [0, 1, 2]);
  // D3 — nothing ever posts the whole capture. Each body is one segment, and the
  // later ones are the header plus that segment and nothing else.
  assert.deepEqual(posted[0], [...HEADER, ...CLUSTER, 0x01]);
  assert.deepEqual(posted[1], [...HEADER, ...CLUSTER, 0x11]);
  assert.deepEqual(posted[2], [...HEADER, ...CLUSTER, 0x22]);
});

test("a queue rebuilt over a reloaded session finds the header without segment 0", async () => {
  // The reload case: segment 0 already transcribed before the tab died, so the
  // port is asked for segment 1 first and has never seen the header.
  const posted: number[][] = [];
  const { store, transcribe } = recording(async (audio) => {
    posted.push([...audio]);
    return "recovered";
  });
  let session = await seed(store, [firstChunk(), laterChunk(0x33)]);
  session = {
    ...session,
    segments: [{ ...session.segments[0]!, state: "done", text: "already had this", attempts: 1 }, session.segments[1]!],
  };

  await createCaptureQueue({ store, session, transcribe }).drain();

  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0], [...HEADER, ...CLUSTER, 0x33]);
});

test("a 503 is an outage, so it costs no retry budget (D7)", async () => {
  let calls = 0;
  const { store, transcribe } = recording(async () => {
    calls += 1;
    throw new SegmentTranscriptionError(503, "sidecar restarting");
  });
  const session = await seed(store, [firstChunk()]);
  const queue = createCaptureQueue({ store, session, transcribe });

  const result = await queue.drain();

  assert.equal(calls, 1);
  assert.equal(result.phase, "unavailable");
  assert.deepEqual([...result.deferred], [0]);
  // The attempt was given back: the segment is queued, not spent, and it is not
  // yet a gap. A few minutes of a dead sidecar must not permanently mark a good
  // meeting as holes.
  assert.equal(queue.session.segments[0]?.attempts, 0);
  assert.equal(queue.session.segments[0]?.state, "pending");
  // The gaps come from the transcript rather than from the drain: the shared
  // model answers "what is missing" once, so a surface and a test cannot end up
  // reading two different copies of it.
  assert.deepEqual(transcriptGaps(result.session), []);
});

test("a 400 is a verdict on this audio, so it becomes a stated gap with its range (D5)", async () => {
  const { store, transcribe } = recording(async () => {
    throw new SegmentTranscriptionError(400, "could not decode");
  });
  const session = await seed(store, [firstChunk()]);
  const queue = createCaptureQueue({ store, session, transcribe });

  let result = await queue.drain();
  while (result.phase === "waiting") {
    // Spend the bound the way the shared policy spends it, rather than reaching
    // into it: what is under test is that the segment ends as a gap, not silence.
    result = await queue.retry(0);
  }

  const gaps = transcriptGaps(result.session);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0]!.text, /00:00:00–00:00:20 could not be transcribed/);
  assert.match(gaps[0]!.failureReason ?? "", /could not decode/);
});

test("a person's retry fills the gap in from the audio still on the device", async () => {
  let failing = true;
  const { store, transcribe } = recording(async () => {
    if (failing) throw new SegmentTranscriptionError(422, "unprocessable");
    return "the words that were there all along";
  });
  const session = await seed(store, [firstChunk()]);
  const queue = createCaptureQueue({ store, session, transcribe });
  await queue.drain();
  assert.equal(queue.session.segments[0]?.state, "failed");

  failing = false;
  const result = await queue.retry(0);

  assert.deepEqual([...result.transcribed], [0]);
  assert.equal(queue.session.segments[0]?.text, "the words that were there all along");
  assert.deepEqual(transcriptGaps(result.session), []);
});

test("the whole session is written back where the next load will find it", async () => {
  const backend = new FakeCaptureBackend();
  const store = new MeetingCaptureStore(backend);
  const session = await seed(store, [firstChunk()]);
  const queue = createCaptureQueue({ store, session, transcribe: async () => "persisted text", title: "Weekly sync" });

  await queue.drain();

  const stored = parseCapturePayload(backend.manifests.get(SESSION_ID)?.payload ?? "");
  assert.equal(stored.title, "Weekly sync");
  assert.equal(stored.mimeType, "audio/webm");
  assert.equal(stored.session?.segments[0]?.text, "persisted text");
  // Not closed: the meeting is still open, so it stays offerable (D2).
  assert.equal(backend.manifests.get(SESSION_ID)?.closed, false);
});

test("audio whose bytes are gone becomes a gap rather than an endless retry", async () => {
  // A torn store — the chunk lists but does not read — is a fact about this
  // segment. Treating it as an outage would retry a file that is never coming
  // back, forever.
  const backend = new FakeCaptureBackend();
  const store = new MeetingCaptureStore(backend);
  const session = await seed(store, [firstChunk()]);
  backend.unreadable.add(`${SESSION_ID}:0`);
  const queue = createCaptureQueue({ store, session, transcribe: async () => "never reached" });

  const result = await queue.drain();

  assert.equal(result.phase !== "unavailable", true);
  assert.deepEqual([...result.failed], [0]);
  assert.match(queue.session.segments[0]?.failureReason ?? "", /no longer readable/);
});

test("at most two requests are in flight at once", async () => {
  // A one-hour meeting is ~180 segments. Firing them all at the sidecar the
  // moment the network returns is a denial of service against our own backend.
  let inFlight = 0;
  let peak = 0;
  const { store, transcribe } = recording(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    await Promise.resolve();
    inFlight -= 1;
    return "text";
  });
  const session = await seed(store, [firstChunk(), laterChunk(1), laterChunk(2), laterChunk(3), laterChunk(4)]);

  await createCaptureQueue({ store, session, transcribe }).drain();

  assert.ok(peak <= 2, `expected at most 2 concurrent requests, saw ${peak}`);
});
