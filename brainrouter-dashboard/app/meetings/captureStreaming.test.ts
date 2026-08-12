/**
 * ADR-035 D10 — the dashboard's live transcription path, driven end to end.
 *
 * This file exists to answer the four questions the ADR marks as acceptance,
 * with values rather than with calls:
 *
 * - does the host pick its strategy from the ENDPOINT's answer, and does an
 *   endpoint that offers no stream leave this page behaving exactly as it does
 *   in production today;
 * - does text appear WHILE a sentence is being spoken, rather than after it;
 * - is the fallback VISIBLE and does it say why (golden rule 23), and does the
 *   segmented path finish the meeting from the audio already on the device;
 * - does a reconnect rebuild its position from what was PERSISTED, so a proof
 *   whose write failed never lets the stream skip past words nothing wrote down.
 *
 * Everything is asserted on what reached the device, the compose box or the
 * wire. `#captureSurfaceHarness` supplies a real store over a real fixture
 * backend, the real shared queue and the real session model; what stands in is
 * the endpoint's behaviour, because when it sends a partial and when it proves
 * coverage is precisely what decides whether a meeting keeps its words.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createStreamingTranscriptionCapabilities, transcriptSoFar } from "@kinqs/brainrouter-core/meetings";

import { parseCapturePayload, serializeCapturePayload } from "../../lib/meetings/capturePayload";
import { MEETING_CAPTURE_TIMESLICE_MS, MeetingCaptureStore } from "../../lib/meetings/captureStore";
import { CaptureOrigin, flush, type CaptureTab, type FakeStream } from "./_captureSurfaceHarness";
import { STREAM_NO_WORKSPACE_NOTICE, STREAM_UNSUPPORTED_NOTICE } from "./captureSurface";

/** An endpoint that meets the whole v1 contract, as `deploy/stt` advertises it. */
const STREAMING = createStreamingTranscriptionCapabilities(["low-latency", "balanced"]);

/** One D9 durability chunk — three seconds, which is what the recorder writes. */
async function chunk(tab: CaptureTab): Promise<void> {
  await tab.chunk(1_024, 7, MEETING_CAPTURE_TIMESLICE_MS);
}

/** Record with the live path available, and land the chunk that opens it. */
async function recordStreaming(tab: CaptureTab): Promise<{ sessionId: string; stream: FakeStream }> {
  tab.capabilities = STREAMING;
  await tab.surface.init();
  await tab.record();
  await chunk(tab);
  const sessionId = tab.state.session?.id;
  assert.ok(sessionId, "a session exists from the press of Record");
  const stream = tab.streams[0];
  assert.ok(stream, "the first durability chunk is what opens the connection");
  return { sessionId, stream };
}

test("D10 — an endpoint advertising no stream leaves this page exactly as production is, and SAYS so", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  // The harness default IS production's document: `streaming: null`.
  await tab.record();
  for (let index = 0; index < 8; index += 1) await chunk(tab);

  assert.deepEqual(tab.streams, [], "no upgrade is attempted against an endpoint that offers none");
  assert.equal(tab.state.transcription, "segmented");
  // Golden rule 23: which path ran, and why the better one did not. Silence here
  // would make a server without the feature indistinguishable from one whose
  // stream is broken.
  assert.equal(tab.state.streamNotice, STREAM_UNSUPPORTED_NOTICE);
  assert.match(tab.state.streamNotice, /transcribed in segments/);

  // …and the segmented path is untouched: 24s of audio is past the 20s unit
  // target, so units seal and the queue transcribes them exactly as before.
  const session = tab.state.session;
  assert.ok(session && session.segments.length >= 1, "the segmented target still seals units");
  assert.equal(tab.state.transcript.includes("spoken words"), true);
});

test("D10 — a recording with no workspace stays segmented, and the reason is the workspace", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab({ orgId: "" });
  tab.capabilities = STREAMING;
  await tab.surface.init();
  await tab.record();
  await chunk(tab);

  // The gateway's attach frame names a tenant and this recording's tenant was
  // frozen at Record (open question 5). Attaching under whatever the switcher
  // shows would be a meeting landing in the wrong workspace over a WebSocket.
  assert.deepEqual(tab.streams, []);
  assert.equal(tab.state.streamNotice, STREAM_NO_WORKSPACE_NOTICE);
});

test("D10/§6 — text appears WHILE the sentence is being spoken, and provisional words never touch the box", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  const { stream } = await recordStreaming(tab);

  assert.equal(stream.request.orgId, "org-a", "the recording's own workspace, not the switcher's");
  assert.equal(stream.request.latencyMode, "low-latency", "the live path asks for the lowest latency offered");
  assert.equal(stream.request.resumeFrom, null, "a new recording resumes from nothing");
  assert.equal(tab.state.transcription, "streaming");

  // The utterance is still being said: it started 200ms in and this revision
  // covers 1.2s of it, inside a three-second chunk nothing has proven yet. If
  // the first text for an utterance can only arrive once the utterance is over,
  // D10 did not land whatever the wiring looks like.
  stream.emit({ kind: "partial", utteranceId: "u0", revision: 0, text: "good mor", startMs: 200, endMs: 1_200 });
  await flush();
  assert.deepEqual(tab.state.live.map((utterance) => [utterance.state, utterance.text]), [["partial", "good mor"]]);
  assert.equal(tab.state.transcript, "", "a revision the endpoint may replace is not written into the compose box");

  // A revision replaces the same utterance rather than appending a second one.
  stream.emit({ kind: "partial", utteranceId: "u0", revision: 1, text: "good morning", startMs: 200, endMs: 2_100 });
  await flush();
  assert.deepEqual(tab.state.live.map((utterance) => [utterance.state, utterance.text]), [["partial", "good morning"]]);
});

test("D10 — a coverage proof settles the words, and only then does the checkpoint exist on the device", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  const { sessionId, stream } = await recordStreaming(tab);

  stream.emit({ kind: "partial", utteranceId: "u0", revision: 0, text: "good mor", startMs: 200, endMs: 1_200 });
  stream.emit({ kind: "final", utteranceId: "u0", revision: 1, text: "good morning everyone", startMs: 200, endMs: 2_400 });
  await flush();
  // Upstream finality is not host durability: the words are the endpoint's last
  // answer, and this device has not written them down.
  assert.deepEqual(tab.state.live.map((utterance) => utterance.state), ["final"]);
  assert.equal(tab.state.transcript, "");
  assert.equal(parseCapturePayload((await origin.record(sessionId))!.payload).checkpoint, undefined);

  stream.emit({ kind: "coverage", coveredThroughSequence: 0 });
  await flush();

  assert.equal(tab.state.transcript, "good morning everyone", "settled text reaches the box through the shared fold");
  assert.deepEqual(tab.state.live, [], "and leaves the provisional band, so the meeting is not shown twice");

  const stored = await origin.session(sessionId, "org-a");
  assert.equal(stored.segments.length, 1);
  assert.deepEqual(stored.segments[0]!.chunks, [0]);
  assert.equal(stored.segments[0]!.state, "done");
  assert.equal(stored.segments[0]!.text, "good morning everyone");
  // The proof and the transcript it covers are the SAME write.
  assert.deepEqual(parseCapturePayload((await origin.record(sessionId))!.payload).checkpoint, {
    kind: "transcript-committed",
    acknowledgedThroughSequence: 0,
  });
});

test("D1/D10 — the bytes are on the device BEFORE any of them is sent, and the ranges are the ledger's", async () => {
  // A write that resolves instantly orders itself before every read by accident,
  // which is the shape that hides a host streaming from the blob in its hand
  // rather than from what it managed to persist.
  const origin = new CaptureOrigin({ writeTicks: 4 });
  const tab = origin.tab();
  tab.capabilities = STREAMING;
  await tab.surface.init();
  await tab.record();
  // A first chunk shaped like what a `MediaRecorder` really produces: a
  // container prologue, then the first cluster. Everything before the cluster is
  // the initialization segment a later connection has to bootstrap with.
  const header = [0x1a, 0x45, 0xdf, 0xa3, 0x99, 0x42, 0x86, 0x81];
  const first = new Uint8Array([...header, 0x1f, 0x43, 0xb6, 0x75, 1, 2, 3, 4]);
  origin.skip(MEETING_CAPTURE_TIMESLICE_MS);
  tab.recorder.emit(new Blob([first]));
  await flush();
  const sessionId = tab.state.session!.id;
  const stream = tab.streams[0]!;
  await chunk(tab);
  await flush();

  // The container header only, not the whole chunk: a connection that was handed
  // the audio as well would decode the first cluster twice on every reconnect.
  assert.deepEqual([...stream.initializations[0]!.initializationSegment], header);

  const wrote = origin.backend.calls.indexOf(`wrote:${sessionId}:0`);
  const read = origin.backend.calls.indexOf(`readChunk:${sessionId}:0`);
  assert.ok(wrote >= 0, "the chunk was written durably");
  assert.ok(read > wrote, "and the stream took its copy from the store, after the write landed");

  // The ledger's own ranges, not a clock read at send time: these are what a
  // coverage proof is indexed by and what D5 prints in a gap marker.
  assert.deepEqual(stream.sent.map((frame) => [frame.sequence, frame.startMs, frame.endMs]), [
    [0, 0, 3_000],
    [1, 3_000, 6_000],
  ]);
  assert.deepEqual([...stream.sent[0]!.audio], [...first], "and the frame carries the chunk's own bytes, whole");
  assert.equal(stream.initializations.length, 1, "the container is bootstrapped exactly once per connection");
});

test("golden rule 23 — a mid-meeting drop is VISIBLE, and the segmented path finishes the meeting", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  const { stream } = await recordStreaming(tab);

  stream.emit({ kind: "final", utteranceId: "u0", revision: 0, text: "before the drop", startMs: 0, endMs: 2_800 });
  stream.emit({ kind: "coverage", coveredThroughSequence: 0 });
  await flush();
  assert.equal(tab.state.transcript, "before the drop");

  stream.drop({ kind: "outage", reason: "the transcription service ended the session" });
  await flush();

  assert.equal(tab.state.transcription, "segmented", "the surface stops promising live text the instant it stops arriving");
  assert.match(tab.state.streamNotice, /^Live transcription stopped — the transcription service ended the session\./);
  assert.match(tab.state.streamNotice, /transcribed in segments/);
  assert.deepEqual(tab.state.live, [], "words the stream never proved are not left on screen looking settled");

  // The endpoint stays down, so nothing reconnects — and the meeting still
  // becomes text. Twenty seconds of audio is one segmented unit, which only
  // seals because the policy went back to the segmented target when the stream
  // went away.
  tab.streamOpenFails = new Error("connection refused");
  for (let index = 0; index < 7; index += 1) await chunk(tab);
  await flush();
  assert.equal(tab.state.transcript, "before the drop\nspoken words");
  assert.equal(
    transcriptSoFar(tab.state.session!).filter((entry) => entry.kind === "settled").length,
    2,
    "one unit from the stream and one from the queue, over ranges that do not overlap",
  );
});

test("D10 — an outage reconnects on the recorder's own cadence and replays from the PERSISTED position", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  const { sessionId, stream } = await recordStreaming(tab);

  stream.emit({ kind: "final", utteranceId: "u0", revision: 0, text: "first stretch", startMs: 0, endMs: 2_800 });
  stream.emit({ kind: "coverage", coveredThroughSequence: 0 });
  await flush();
  await chunk(tab);
  await chunk(tab);
  await flush();
  assert.deepEqual(stream.sent.map((frame) => frame.sequence), [0, 1, 2]);

  stream.drop({ kind: "outage", reason: "the connection dropped" });
  await flush();
  assert.equal(tab.streams.length, 1, "a drop does not spin: nothing reconnects until the next chunk lands");

  await chunk(tab);
  await flush();
  const resumed = tab.streams[1];
  assert.ok(resumed, "the next durability chunk is the retry, so there is no interval here to get wrong");
  assert.deepEqual(resumed.request.resumeFrom, { kind: "transcript-committed", acknowledgedThroughSequence: 0 });
  // Everything after what the endpoint accepted, replayed out of the store —
  // including the chunks that were already sent to the connection that died.
  assert.deepEqual(resumed.sent.map((frame) => frame.sequence), [1, 2, 3]);
  assert.equal(resumed.initializations.length, 1, "and the new connection is bootstrapped again");

  // The reconnected endpoint mints its own utterance ids from zero. A live
  // buffer carried across would make the reducer read this as a late revision of
  // a final it already had and drop the words.
  resumed.emit({ kind: "final", utteranceId: "u0", revision: 0, text: "after the reconnect", startMs: 3_100, endMs: 11_000 });
  resumed.emit({ kind: "coverage", coveredThroughSequence: 3 });
  await flush();
  assert.equal(tab.state.transcript, "first stretch\nafter the reconnect");
  assert.deepEqual(parseCapturePayload((await origin.record(sessionId))!.payload).checkpoint, {
    kind: "transcript-committed",
    acknowledgedThroughSequence: 3,
  });
});

test("D10 — an endpoint that accepts LESS than was asked for is replayed from where it actually is", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  const { stream } = await recordStreaming(tab);
  stream.emit({ kind: "final", utteranceId: "u0", revision: 0, text: "one", startMs: 0, endMs: 2_000 });
  stream.emit({ kind: "coverage", coveredThroughSequence: 0 });
  await flush();
  await chunk(tab);
  stream.drop({ kind: "outage", reason: "the connection dropped" });
  await flush();

  // The adapter declines the resume outright: it is the authority on what it
  // holds, and the host's answer is more audio from the disk, never a gap.
  tab.acceptResume = () => null;
  await chunk(tab);
  await flush();
  assert.deepEqual(tab.streams[1]!.sent.map((frame) => frame.sequence), [0, 1, 2]);
});

test("D10 — a REFUSED drop stops trying, and says so without promising a reconnect", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  const { stream } = await recordStreaming(tab);

  stream.drop({ kind: "refused", reason: "the server could not decode this recording's audio" });
  await flush();
  assert.match(tab.state.streamNotice, /could not decode/);
  assert.equal(/comes back/.test(tab.state.streamNotice), false, "a verdict on this audio is not something to wait out");

  for (let index = 0; index < 4; index += 1) await chunk(tab);
  await flush();
  assert.equal(tab.streams.length, 1, "nothing reconnects to an endpoint that will never take these bytes");
});

test("D10 — a coverage proof whose WRITE failed is not resume authority, so nothing is skipped", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  const { sessionId, stream } = await recordStreaming(tab);
  stream.emit({ kind: "final", utteranceId: "u0", revision: 0, text: "kept", startMs: 0, endMs: 2_800 });
  stream.emit({ kind: "coverage", coveredThroughSequence: 0 });
  await flush();
  await chunk(tab);
  await flush();

  // The next manifest write refuses — the store is full, the tab is dying, the
  // browser said no. The audio is unaffected; what fails is the record of it.
  origin.backend.refuseNextManifest = true;
  stream.emit({ kind: "final", utteranceId: "u1", revision: 0, text: "not written down", startMs: 3_100, endMs: 5_800 });
  stream.emit({ kind: "coverage", coveredThroughSequence: 1 });
  await flush();

  assert.match(tab.state.warning, /live transcript could not be saved/i);
  assert.deepEqual(
    parseCapturePayload((await origin.record(sessionId))!.payload).checkpoint,
    { kind: "transcript-committed", acknowledgedThroughSequence: 0 },
    "the device still says it has proven exactly what it has proven",
  );

  stream.drop({ kind: "outage", reason: "the connection dropped" });
  await flush();
  await chunk(tab);
  await flush();
  // The reconnect asks for the position on the DEVICE, not the one the reducer
  // reached. Re-sent audio costs a moment; a checkpoint that outran its
  // transcript costs the words between the two.
  assert.deepEqual(tab.streams[1]!.request.resumeFrom, {
    kind: "transcript-committed",
    acknowledgedThroughSequence: 0,
  });
  assert.deepEqual(tab.streams[1]!.sent.map((frame) => frame.sequence), [1, 2]);
});

test("D4 — an edit is never overwritten by a late arrival, streamed or not", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  const { stream } = await recordStreaming(tab);
  stream.emit({ kind: "final", utteranceId: "u0", revision: 0, text: "recieve the agenda", startMs: 0, endMs: 2_800 });
  stream.emit({ kind: "coverage", coveredThroughSequence: 0 });
  await flush();
  assert.equal(tab.state.transcript, "recieve the agenda");

  tab.surface.setTranscript("receive the agenda");
  await chunk(tab);
  stream.emit({ kind: "final", utteranceId: "u1", revision: 0, text: "and the minutes", startMs: 3_100, endMs: 5_800 });
  stream.emit({ kind: "coverage", coveredThroughSequence: 1 });
  await flush();

  assert.equal(tab.state.transcript, "receive the agenda\nand the minutes", "the correction stands and the meeting keeps its order");
});

test("§6 — kill a STREAMING recording, reopen, and the meeting is there with its transcript exactly once", async () => {
  const origin = new CaptureOrigin();
  const first = origin.tab();
  const { sessionId, stream } = await recordStreaming(first);
  stream.emit({ kind: "final", utteranceId: "u0", revision: 0, text: "streamed words", startMs: 0, endMs: 2_800 });
  stream.emit({ kind: "coverage", coveredThroughSequence: 0 });
  await flush();
  // More audio the stream never proved. It is on the device and unclaimed, which
  // is exactly what the segmented queue is for.
  await chunk(first);
  await chunk(first);
  await flush();

  first.kill();

  const second = origin.tab();
  await second.surface.init();
  await second.surface.refreshRecoverable();
  const offered = second.state.recoverable;
  assert.equal(offered.length, 1, "the browser dropped the dead tab's lock, so the meeting is offered back at once");
  assert.equal(offered[0]!.session.id, sessionId);

  await second.surface.pickUp(offered[0]!);
  await flush();

  const words = second.state.transcript.split("\n");
  assert.equal(words.filter((line) => line === "streamed words").length, 1, "the streamed text comes back exactly once");
  assert.equal(words.includes("spoken words"), true, "and the audio the stream never covered is transcribed from the device");
  assert.deepEqual(second.streams, [], "a recovered recording is stopped, so nothing streams into it");

  const audio = await origin.record(sessionId);
  assert.equal(audio?.chunks.length, 3, "every durability chunk written before the kill is still on the device");
});

/**
 * Record, prove one chunk, kill the tab, optionally rewrite the stored token,
 * then pick the recording up in a fresh tab — and report what the manifest says
 * afterwards. The pick-up rewrites the whole payload, so what survives it is
 * exactly what this host is willing to treat as authority.
 */
async function checkpointAfterPickUp(
  rewrite?: (acknowledgedThroughSequence: number) => number,
): Promise<unknown> {
  const origin = new CaptureOrigin();
  const first = origin.tab();
  const { sessionId, stream } = await recordStreaming(first);
  stream.emit({ kind: "final", utteranceId: "u0", revision: 0, text: "proven", startMs: 0, endMs: 2_800 });
  stream.emit({ kind: "coverage", coveredThroughSequence: 0 });
  await flush();
  first.kill();

  if (rewrite) {
    const store = new MeetingCaptureStore(origin.backend);
    const payload = parseCapturePayload((await origin.record(sessionId))!.payload);
    await store.setPayload(sessionId, serializeCapturePayload({
      ...payload,
      checkpoint: { kind: "transcript-committed", acknowledgedThroughSequence: rewrite(0) },
    }));
  }

  const second = origin.tab();
  await second.surface.init();
  await second.surface.refreshRecoverable();
  await second.surface.pickUp(second.state.recoverable[0]!);
  await flush();
  return parseCapturePayload((await origin.record(sessionId))!.payload).checkpoint;
}

test("D10 — a stored checkpoint survives a pick-up, and an unprovable one does not", async () => {
  // It is the RECORDING's proof, not a tab's, so adopting the recording must not
  // quietly delete it from the record.
  assert.deepEqual(await checkpointAfterPickUp(), { kind: "transcript-committed", acknowledgedThroughSequence: 0 });

  // …and a token pointing past every chunk this device holds — a torn write, a
  // payload copied by hand, a reap that took the audio and left the record — is
  // dropped. Believed, it would resume a stream past speech nothing transcribed.
  assert.equal(await checkpointAfterPickUp(() => 9), undefined);
});

test("Stop lets the connection go, and the tail the stream never covered is transcribed from the device", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  const { stream } = await recordStreaming(tab);
  stream.emit({ kind: "final", utteranceId: "u0", revision: 0, text: "the whole point", startMs: 0, endMs: 2_800 });
  stream.emit({ kind: "coverage", coveredThroughSequence: 0 });
  await flush();
  await chunk(tab);

  await tab.stop();
  await flush();

  assert.equal(stream.closes, 1, "the endpoint is told the audio ended");
  assert.equal(tab.state.transcription, "segmented");
  assert.deepEqual(tab.state.live, []);
  // A coverage proof that arrives after Stop can claim nothing: `stopCapture`
  // sealed the tail, and a seal only ever takes the OPEN suffix. So no range is
  // transcribed twice, and the tail is still text.
  stream.emit({ kind: "coverage", coveredThroughSequence: 1 });
  await flush();
  assert.equal(tab.state.transcript, "the whole point\nspoken words");
});

test("D10 — a partial arriving inside a coverage commit is not discarded", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  const { sessionId, stream } = await recordStreaming(tab);

  // The bundled sidecar emits these three in ONE pass, at the same millisecond:
  // deploy/stt/stream.mjs writes final, then the proof, then the next
  // utterance's first words. Dispatched concurrently, the partial reduced from
  // the state as it was BEFORE the coverage commit's store write and was then
  // overwritten by it — so the first words of every new utterance vanished, and
  // a `final` caught the same way left a unit marked done with nothing in it.
  stream.emit({ kind: "final", utteranceId: "u0", revision: 0, text: "good morning everyone", startMs: 0, endMs: 2_400 });
  stream.emit({ kind: "coverage", coveredThroughSequence: 0 });
  stream.emit({ kind: "partial", utteranceId: "u1", revision: 0, text: "next thing", startMs: 3_100, endMs: 3_600 });
  for (let i = 0; i < 8; i += 1) await flush();

  assert.equal(tab.state.transcript, "good morning everyone", "the covered words still settle");
  assert.deepEqual(
    tab.state.live.map((utterance) => utterance.text),
    ["next thing"],
    "and the partial that landed during that commit survives it",
  );
  const stored = await origin.session(sessionId, "org-a");
  assert.equal(stored.segments[0]!.text, "good morning everyone");
});
