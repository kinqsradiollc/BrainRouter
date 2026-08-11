/**
 * ADR-035 D1b/D9 — the durable capture protocol, exercised where the decisions are.
 *
 * These run directly with node:test + tsx through the dashboard test script.
 * Neither OPFS nor IndexedDB exists here, which is exactly why
 * `MeetingCaptureStore` holds all of the logic and the two backends hold none:
 * everything asserted below is behaviour the real store performs against the
 * real seam, not behaviour a mock performs against itself.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  appendChunk as appendCaptureChunk,
  createCaptureSession,
  discardCapture,
  finalizeCapture,
} from "@kinqs/brainrouter-core/meetings";

import { audioBlob, FakeCaptureBackend } from "./_captureBackendFixture";
import { resumableCaptures, serializeCapturePayload } from "./capturePayload";
import { MeetingCaptureStore, MEETING_CAPTURE_TIMESLICE_MS, type MeetingCaptureStoreOptions } from "./captureStore";

/**
 * D2's offer is not a store method — the store treats `payload` as opaque text,
 * so it can see neither a session's terminal state nor its scope. It is the
 * shared `resumableSessions`, asked through `capturePayload.ts`, over `list()`.
 * These assertions go through that pair because what they are about is what a
 * user is offered back.
 */
const SCOPE = { orgId: null };

async function offered(subject: MeetingCaptureStore): Promise<readonly string[]> {
  return resumableCaptures(await subject.list(), { scope: SCOPE }).map((entry) => entry.record.sessionId);
}

function store(backend = new FakeCaptureBackend(), options: MeetingCaptureStoreOptions = {}): MeetingCaptureStore {
  return new MeetingCaptureStore(backend, options);
}

test("D9 — the durability cadence stays inside the ADR's 2–5s loss bound", () => {
  assert.ok(MEETING_CAPTURE_TIMESLICE_MS >= 2_000 && MEETING_CAPTURE_TIMESLICE_MS <= 5_000);
});

test("a new manifest refuses a cadence outside D9's integer loss bound", async () => {
  const subject = store();
  for (const chunkMs of [1_999, 5_001, 3_000.5]) {
    await assert.rejects(
      () => subject.begin({ sessionId: `mtg-invalid-${String(chunkMs).replace(".", "-")}`, chunkMs }),
      /whole number from 2,000 to 5,000 milliseconds/,
    );
  }
});

test("a session exists before any audio does", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  const record = await subject.begin({ sessionId: "mtg-1", startedAt: "2026-08-10T09:00:00.000Z" });
  assert.equal(record.byteLength, 0);
  assert.equal(record.closed, false);
  assert.ok(backend.manifests.has("mtg-1"));
});

test("beginning twice refuses to write over an existing capture", async () => {
  const subject = store();
  await subject.begin({ sessionId: "mtg-1" });
  await assert.rejects(() => subject.begin({ sessionId: "mtg-1" }), /already exists/);
});

test("a chunk is readable with no further bookkeeping write", async () => {
  // D1b: a closing tab gets very little time, so the audio must survive without
  // any write after the bytes themselves.
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  backend.calls.length = 0;
  await subject.appendChunk("mtg-1", audioBlob(64, 1));
  assert.deepEqual(backend.calls.filter((call) => call.startsWith("writeManifest")), []);
  const record = await subject.read("mtg-1");
  assert.equal(record?.byteLength, 64);
  assert.deepEqual(record?.chunks, [{ sequence: 0, byteLength: 64 }]);
});

test("audio written straight to the backend is still reported by the store", async () => {
  // The bytes are the truth: a record that never got updated cannot hide them.
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  await backend.writeChunk("mtg-1", 0, audioBlob(32, 7));
  await backend.writeChunk("mtg-1", 1, audioBlob(48, 7));
  const record = await subject.read("mtg-1");
  assert.equal(record?.byteLength, 80);
});

test("concurrent appends get distinct sequences in call order", async () => {
  // MediaRecorder fires ondataavailable without awaiting anything, so this is
  // the ordinary case, not the exotic one.
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  const refs = await Promise.all([
    subject.appendChunk("mtg-1", audioBlob(10, 1)),
    subject.appendChunk("mtg-1", audioBlob(20, 2)),
    subject.appendChunk("mtg-1", audioBlob(30, 3)),
  ]);
  assert.deepEqual(refs.map((ref) => ref.sequence), [0, 1, 2]);
  assert.deepEqual(refs.map((ref) => ref.byteLength), [10, 20, 30]);
});

test("a failed chunk write leaves its sequence free and does not end the recording", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  await subject.appendChunk("mtg-1", audioBlob(16, 1));
  backend.failWrites.add("mtg-1:1");
  await assert.rejects(() => subject.appendChunk("mtg-1", audioBlob(16, 2)), /refused/);
  const next = await subject.appendChunk("mtg-1", audioBlob(16, 3));
  assert.equal(next.sequence, 1, "the free sequence is reused, so the audio has no hole");
  const record = await subject.read("mtg-1");
  assert.deepEqual(record?.chunks.map((chunk) => chunk.sequence), [0, 1]);
});

test("audio reassembles in sequence order even when the backend lists out of order", async () => {
  const backend = new FakeCaptureBackend({ shuffleListing: true });
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  await subject.appendChunk("mtg-1", audioBlob(2, 0xaa));
  await subject.appendChunk("mtg-1", audioBlob(2, 0xbb));
  await subject.appendChunk("mtg-1", audioBlob(2, 0xcc));
  const audio = await subject.readAudio("mtg-1");
  assert.deepEqual([...new Uint8Array(await audio.blob.arrayBuffer())], [0xaa, 0xaa, 0xbb, 0xbb, 0xcc, 0xcc]);
  assert.deepEqual(audio.missing, []);
});

test("readAudio keeps physical chunks after a sequence hole and names the hole", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-hole", payload: "{not valid session JSON" });
  await backend.writeChunk("mtg-hole", 0, audioBlob(2, 0xaa));
  await backend.writeChunk("mtg-hole", 2, audioBlob(2, 0xcc));

  const audio = await subject.readAudio("mtg-hole");
  assert.deepEqual(
    [...new Uint8Array(await audio.blob.arrayBuffer())],
    [0xaa, 0xaa, 0xcc, 0xcc],
    "a hole does not silently truncate every later physical chunk",
  );
  assert.deepEqual(audio.missing, [1], "the missing physical sequence is reported honestly");
});

test("readAudio names a trailing chunk only a valid matching payload ledger claims", async () => {
  let session = createCaptureSession({ id: "mtg-trailing", scope: SCOPE });
  session = appendCaptureChunk(session, { byteLength: 2, durationMs: 3_000 });
  session = appendCaptureChunk(session, { byteLength: 2, durationMs: 3_000 });
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({
    sessionId: session.id,
    payload: serializeCapturePayload({ session }),
  });
  await backend.writeChunk(session.id, 0, audioBlob(2, 0xaa));

  const audio = await subject.readAudio(session.id);
  assert.equal(audio.byteLength, 2);
  assert.deepEqual(audio.missing, [1], "the valid ledger makes a missing trailing file visible");

  const copied = createCaptureSession({ id: "mtg-someone-else", scope: { orgId: "org-other" } });
  await subject.setPayload(session.id, serializeCapturePayload({ session: copied }));
  assert.deepEqual(
    (await subject.readAudio(session.id)).missing,
    [],
    "a valid session copied from another record supplies neither sequences nor tenant authority",
  );
});

test("an unreadable chunk is reported, not thrown away and not thrown", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  await subject.appendChunk("mtg-1", audioBlob(4, 1));
  await subject.appendChunk("mtg-1", audioBlob(4, 2));
  backend.unreadable.add("mtg-1:0");
  const audio = await subject.readAudio("mtg-1");
  assert.deepEqual(audio.missing, [0]);
  assert.equal(audio.byteLength, 4, "the rest of the meeting still comes back");
});

test("a chunk whose read THROWS is reported too — one bad chunk does not cost the meeting", async () => {
  // The reproduction: `preview` came back null and the whole recovered meeting
  // was unplayable while five of six chunks sat on the device, because the
  // read of chunk 2 rejected instead of resolving `undefined`. Both real
  // backends reject — IndexedDB on `onerror`/`onabort`, OPFS when `getFile()`
  // finds the entry gone — so this is the ordinary injury, not the exotic one.
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  for (const fill of [1, 2, 3]) await subject.appendChunk("mtg-1", audioBlob(4, fill));
  backend.failReads.add("mtg-1:1");

  const audio = await subject.readAudio("mtg-1");
  assert.deepEqual(audio.missing, [1], "the saved chunk that could not be read is NAMED");
  assert.equal(audio.byteLength, 8, "and the rest of the recording is still playable");
});

test("an empty chunk is refused", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  await assert.rejects(() => subject.appendChunk("mtg-1", new Blob([])), /at least one byte/);
  assert.deepEqual(await offered(subject), [], "a session of empty chunks is not offered back");
});

test("an unsafe session id never reaches the backend", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  for (const id of ["../escape", "a/b", "", ".", "has space"]) {
    await assert.rejects(() => subject.begin({ sessionId: id }), /letters, digits, dash or underscore/);
  }
  assert.deepEqual(backend.calls, []);
});

test("a reloaded tab continues an existing capture's numbering", async () => {
  const backend = new FakeCaptureBackend();
  const first = store(backend);
  await first.begin({ sessionId: "mtg-1" });
  await first.appendChunk("mtg-1", audioBlob(8, 1));
  await first.appendChunk("mtg-1", audioBlob(8, 2));

  // A fresh store is what a reloaded tab gets: no in-memory sequence counter. It
  // seeds itself from the chunks the backend actually holds, so picking a
  // recovered capture back up cannot overwrite the audio it came back with.
  const second = store(backend);
  const record = await second.read("mtg-1");
  assert.equal(record?.byteLength, 16);
  const next = await second.appendChunk("mtg-1", audioBlob(8, 3));
  assert.equal(next.sequence, 2);
});

test("reading a capture that is not stored answers 'nothing here' rather than inventing one", async () => {
  assert.equal(await store().read("mtg-missing"), undefined);
});

test("recovery offers sessions with audio and no terminal state, newest first", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "old", startedAt: "2026-08-10T08:00:00.000Z" });
  await subject.appendChunk("old", audioBlob(4, 1));
  await subject.begin({ sessionId: "new", startedAt: "2026-08-10T09:00:00.000Z" });
  await subject.appendChunk("new", audioBlob(4, 2));
  await subject.begin({ sessionId: "empty", startedAt: "2026-08-10T10:00:00.000Z" });
  await subject.begin({ sessionId: "done", startedAt: "2026-08-10T11:00:00.000Z" });
  await subject.appendChunk("done", audioBlob(4, 3));
  await subject.setPayload("done", "{}", { closed: true });

  assert.deepEqual(await offered(subject), ["new", "old"]);
});

test("the payload round-trips without erasing its independent durability cadence", async () => {
  const subject = store();
  await subject.begin({ sessionId: "mtg-1", chunkMs: 3_000, payload: '{"segments":[]}' });
  const updated = await subject.setPayload("mtg-1", '{"segments":[{"index":0}]}');
  assert.equal(updated.payload, '{"segments":[{"index":0}]}');
  assert.equal(updated.closed, false, "settling is a separate, explicit decision");
  assert.equal(updated.chunkMs, 3_000, "opaque session JSON cannot erase the recovery cadence");
});

test("a slow backend cannot lose the chunk that was still being written at Stop", async () => {
  // The reproduction of the defect this drain exists for. `ondataavailable` and
  // `onstop` are both handlers that cannot await, so Stop calls readAudio while
  // the final write is still in flight; with an OPFS-shaped backend (a write
  // costs more ticks than a read) the read used to overtake it and transcription
  // received a meeting missing its last durability chunk.
  const backend = new FakeCaptureBackend({ writeTicks: 5 });
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });

  void subject.appendChunk("mtg-1", audioBlob(1000, 1));
  void subject.appendChunk("mtg-1", audioBlob(1000, 2));
  void subject.appendChunk("mtg-1", audioBlob(1000, 3));
  await subject.settled("mtg-1");

  const audio = await subject.readAudio("mtg-1");
  assert.equal(audio.byteLength, 3000, "every recorded byte reaches transcription");
  assert.deepEqual(audio.missing, []);
  assert.ok(
    // `lastIndexOf` for the listing: `begin` seeds the sequence with one of its
    // own, so the first listing is not the read under test.
    backend.calls.indexOf("wrote:mtg-1:2") < backend.calls.lastIndexOf("listChunks:mtg-1"),
    "the last chunk lands before the read that follows it",
  );
});

test("readAudio alone waits for the writes queued before it", async () => {
  // Belt and braces: a caller that forgets `settled` still cannot read a
  // truncated meeting, because the read is queued behind the writes.
  const backend = new FakeCaptureBackend({ writeTicks: 5 });
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  void subject.appendChunk("mtg-1", audioBlob(1000, 1));
  void subject.appendChunk("mtg-1", audioBlob(1000, 2));
  void subject.appendChunk("mtg-1", audioBlob(1000, 3));
  assert.equal((await subject.readAudio("mtg-1")).byteLength, 3000);
});

test("settled with no session id drains every recording in flight", async () => {
  const backend = new FakeCaptureBackend({ writeTicks: 3 });
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  await subject.begin({ sessionId: "mtg-2" });
  void subject.appendChunk("mtg-1", audioBlob(8, 1));
  void subject.appendChunk("mtg-2", audioBlob(16, 2));
  await subject.settled();
  assert.equal((await subject.read("mtg-1"))?.byteLength, 8);
  assert.equal((await subject.read("mtg-2"))?.byteLength, 16);
});

test("settled resolves even when the write it is waiting on fails", async () => {
  // A drain that rethrows would turn one refused chunk into a Stop that never
  // completes, which loses the whole meeting instead of one segment of it.
  const backend = new FakeCaptureBackend({ writeTicks: 2 });
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  backend.failWrites.add("mtg-1:0");
  void subject.appendChunk("mtg-1", audioBlob(8, 1)).catch(() => {});
  await subject.settled("mtg-1");
  assert.equal((await subject.read("mtg-1"))?.byteLength, 0);
});

test("a delete cannot be undone by a write that was still in flight", async () => {
  // The quota half of the same race. An OPFS write re-creates the session
  // directory, so a chunk landing after deleteSession leaves audio with no
  // manifest — invisible to `resumable`, undeletable by any user, and holding
  // origin quota until the browser evicts the whole site.
  const backend = new FakeCaptureBackend({ writeTicks: 5 });
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  void subject.appendChunk("mtg-1", audioBlob(1000, 1));
  void subject.appendChunk("mtg-1", audioBlob(1000, 2));
  await subject.delete("mtg-1");
  await subject.settled("mtg-1");

  assert.equal(backend.chunks.size, 0, "no audio survives the deletion");
  assert.deepEqual(await subject.listStoredSessionIds(), []);
});

test("a session recorded after its own deletion starts numbering again at zero", async () => {
  // The sequence counter is per session id, so a delete has to clear it or the
  // next recording under a reused id would start above the chunks it can see.
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  await subject.appendChunk("mtg-1", audioBlob(4, 1));
  await subject.delete("mtg-1");
  await subject.begin({ sessionId: "mtg-1" });
  assert.equal((await subject.appendChunk("mtg-1", audioBlob(4, 2))).sequence, 0);
});

test("delete removes the audio and the record", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  await subject.appendChunk("mtg-1", audioBlob(4, 1));
  await subject.delete("mtg-1");
  assert.equal(await subject.read("mtg-1"), undefined);
  assert.equal(backend.chunks.size, 0);
});

test("reaping deletes audio no manifest claims, and names it", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "known" });
  await subject.appendChunk("known", audioBlob(4, 1));
  // Chunks with no manifest: nothing lists it, nothing can offer it back, and no
  // user could ever delete it.
  await backend.writeChunk("orphan", 0, audioBlob(4, 2));

  assert.deepEqual(await subject.reapOrphans(), ["orphan"]);
  assert.deepEqual(await subject.listStoredSessionIds(), ["known"]);
});

for (const kind of ["opfs", "indexeddb"] as const) {
  test(`${kind} keeps corrupt-manifest audio quarantined across repeated boots`, async () => {
    const backend = new FakeCaptureBackend({ kind });
    await backend.writeChunk("mtg-corrupt", 0, audioBlob(4, 7));
    await backend.writeChunk("mtg-corrupt", 1, audioBlob(6, 8));
    backend.corruptManifests.add("mtg-corrupt");
    // The control has genuinely absent top-level metadata and remains eligible
    // for ordinary orphan cleanup.
    await backend.writeChunk("true-orphan", 0, audioBlob(3, 9));

    const firstBoot = store(backend);
    assert.deepEqual(await firstBoot.list(), [], "corrupt metadata cannot invent a tenant-scoped record");
    assert.deepEqual(await offered(firstBoot), [], "and cannot become a recovery offer under the current tenant");
    await assert.rejects(
      () => firstBoot.begin({ sessionId: "mtg-corrupt" }),
      /already exists/,
      "Record cannot overwrite bytes merely because their manifest is corrupt",
    );
    assert.deepEqual(await firstBoot.reapOrphans(), ["true-orphan"]);
    assert.equal(backend.chunks.get("mtg-corrupt:0")?.size, 4);
    assert.equal(backend.chunks.get("mtg-corrupt:1")?.size, 6);
    assert.equal(backend.chunks.has("true-orphan:0"), false, "a truly absent manifest still reaps");

    const secondBoot = store(backend);
    assert.deepEqual(await secondBoot.reapOrphans(), []);
    assert.deepEqual(await secondBoot.listStoredSessionIds(), ["mtg-corrupt"]);
    assert.equal(backend.chunks.get("mtg-corrupt:0")?.size, 4);
    assert.equal(backend.chunks.get("mtg-corrupt:1")?.size, 6);
    assert.equal(
      backend.calls.some((call) => call === "deleteSession:mtg-corrupt"),
      false,
      "neither boot attempts to delete quarantined audio",
    );
  });
}

test("a live recording is never reaped, not even one this store has never seen", async () => {
  // THE data-loss reproduction. The reap used to be told which sessions were
  // known, by a caller that had listed them a moment earlier — so a recording
  // that began in between was missing from that list, present in the reap's own
  // later listing, and deleted mid-meeting. `openMeetingCaptureStore` mints a
  // new store per call, so the load-time reap and the Record path genuinely do
  // hold different instances over the same origin.
  const backend = new FakeCaptureBackend();
  const recorder = store(backend);
  await recorder.begin({ sessionId: "mtg-new" });
  await recorder.appendChunk("mtg-new", audioBlob(64, 1));

  const reaper = store(backend);
  assert.deepEqual(await reaper.reapOrphans(), []);
  assert.equal((await recorder.read("mtg-new"))?.byteLength, 64, "the meeting in progress survives");
  assert.equal((await offered(recorder)).length, 1, "and can still be offered back");
});

test("the reap only deletes what its own snapshot saw", async () => {
  // The other half of the same race: a session that begins DURING the reap is
  // absent from the listing the reap decides from, so it cannot be a candidate.
  const backend = new FakeCaptureBackend();
  const reaper = store(backend);
  const recorder = store(backend);
  const listSessionIds = backend.listSessionIds.bind(backend);
  backend.listSessionIds = async () => {
    const ids = await listSessionIds();
    // Record is pressed the instant after the snapshot is taken.
    await recorder.begin({ sessionId: "mtg-mid-reap" });
    await recorder.appendChunk("mtg-mid-reap", audioBlob(32, 2));
    return ids;
  };

  assert.deepEqual(await reaper.reapOrphans(), []);
  assert.equal((await recorder.read("mtg-mid-reap"))?.byteLength, 32);
});

test("the recording in hand survives a reap even before its first chunk", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "in-hand" });
  assert.deepEqual(await subject.reapOrphans({ keep: ["in-hand"] }), []);
  assert.ok(await subject.read("in-hand"));
});

for (const [status, settle] of [
  ["finalized", finalizeCapture],
  ["discarded", discardCapture],
] as const) {
  test(`a valid ${status} capture whose audio outlived its delete is reaped`, async () => {
    const sessionId = `mtg-${status}`;
    let session = createCaptureSession({ id: sessionId, scope: SCOPE });
    const backend = new FakeCaptureBackend();
    const subject = store(backend);
    await subject.begin({ sessionId, payload: serializeCapturePayload({ session }) });
    await subject.appendChunk(sessionId, audioBlob(8, 1));
    session = appendCaptureChunk(session, { byteLength: 8, durationMs: 3_000 });
    const terminal = settle(session, "2026-08-11T10:00:00.000Z");
    await subject.setPayload(sessionId, serializeCapturePayload({ session: terminal }), { closed: true });

    assert.deepEqual(await subject.reapOrphans(), [sessionId]);
    assert.deepEqual(await subject.listStoredSessionIds(), []);
  });
}

test("a closed bit flipped over a valid live payload cannot authorize audio deletion", async () => {
  let session = createCaptureSession({ id: "mtg-live-closed", scope: SCOPE });
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: session.id, payload: serializeCapturePayload({ session }) });
  await subject.appendChunk(session.id, audioBlob(8, 1));
  session = appendCaptureChunk(session, { byteLength: 8, durationMs: 3_000 });
  // The payload remains byte-for-byte a valid live session; only the small
  // top-level index bit is changed, reproducing the unsafe deletion authority.
  await subject.setPayload(session.id, serializeCapturePayload({ session }), { closed: true });

  assert.deepEqual(await subject.reapOrphans(), []);
  assert.equal(backend.chunks.get(`${session.id}:0`)?.size, 8);
  assert.deepEqual(await offered(subject), [], "quarantine does not re-home the capture under a tenant");
});

test("a closed manifest with corrupt payload is quarantined rather than reaped", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-corrupt-closed", payload: "{torn" });
  await subject.appendChunk("mtg-corrupt-closed", audioBlob(8, 1));
  await subject.setPayload("mtg-corrupt-closed", "{torn", { closed: true });

  assert.deepEqual(await subject.reapOrphans(), []);
  assert.equal(backend.chunks.get("mtg-corrupt-closed:0")?.size, 8);
  assert.deepEqual(await offered(subject), []);
});

test("reaping clears leftovers this model would never have minted", async () => {
  // Something else wrote into the capture root. Refusing to reap it because the
  // name fails the id shape would leave quota consumed by data nobody owns.
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await backend.writeChunk("not a valid id", 0, audioBlob(4, 1));
  assert.deepEqual(await subject.reapOrphans(), ["not a valid id"]);
  assert.deepEqual(await subject.listStoredSessionIds(), []);
});

test("a capture the store holds nothing for is left alone by the reap", async () => {
  // The cross-tab case. OPFS belongs to the origin, so a second tab that has
  // just created a session directory and not yet finished its manifest write
  // shows up here as a session with nothing in it — and deleting that would
  // destroy a recording somebody started a millisecond ago.
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  // The directory exists; neither the manifest nor a chunk does yet.
  const listSessionIds = backend.listSessionIds.bind(backend);
  backend.listSessionIds = async () => [...(await listSessionIds()), "mid-begin"];

  assert.deepEqual(await subject.reapOrphans(), []);
  assert.deepEqual(backend.calls.filter((call) => call.startsWith("deleteSession")), []);
});

test("a begin cannot be erased by a delete that was still in flight", async () => {
  // `begin` used to write its manifest outside the queue, so the delete of the
  // previous recording under that id could land AFTER it: chunks then arrive
  // into a session with no manifest, which `list` cannot see and `resumable`
  // cannot offer — the meeting is invisible while the microphone is still open.
  const backend = new FakeCaptureBackend({ deleteTicks: 5 });
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  await subject.appendChunk("mtg-1", audioBlob(8, 1));

  const deletion = subject.delete("mtg-1");
  const restarted = subject.begin({ sessionId: "mtg-1" });
  await Promise.all([deletion, restarted]);
  await subject.appendChunk("mtg-1", audioBlob(16, 2));

  const record = await subject.read("mtg-1");
  assert.ok(record, "the session that began after the delete still has its manifest");
  assert.equal(record?.byteLength, 16, "and holds only the new recording's audio");
});

test("a payload write cannot resurrect a session that was deleted under it", async () => {
  // `setPayload` is the transcription queue's persist port, and a read-then-write
  // pair: it reads the manifest, then writes the next one back. Off the queue a
  // delete lands between the halves and the write re-creates the manifest —
  // leaving a zero-byte session `resumable` will not offer, no user can remove,
  // and D6 says should simply not exist.
  const backend = new FakeCaptureBackend({ manifestTicks: 5 });
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  await subject.appendChunk("mtg-1", audioBlob(8, 1));

  const persist = subject.setPayload("mtg-1", '{"segments":[]}').catch(() => undefined);
  await subject.delete("mtg-1");
  await persist;

  assert.equal(await subject.read("mtg-1"), undefined, "the deletion is a real deletion");
  assert.deepEqual(await subject.listStoredSessionIds(), []);
});

test("the budget warns while there is still time to act", async () => {
  const subject = store(new FakeCaptureBackend(), {
    persisted: true,
    estimate: async () => ({ usage: 900_000_000, quota: 1_000_000_000 }),
  });
  const budget = await subject.budget();
  assert.equal(budget.level, "approaching");
  assert.match(budget.message, /filling up/);
});

test("an estimate that throws reads as an unknown budget, never as a healthy one", async () => {
  const subject = store(new FakeCaptureBackend(), {
    persisted: true,
    estimate: async () => {
      throw new Error("no estimate here");
    },
  });
  const budget = await subject.budget();
  assert.equal(budget.level, "unknown");
  assert.notEqual(budget.message, "");
});

test("a recording rate turns the budget into remaining minutes", async () => {
  const subject = store(new FakeCaptureBackend(), {
    persisted: true,
    // Plenty of headroom by fraction (2% used), but only ~100s at this rate.
    estimate: async () => ({ usage: 20_000_000, quota: 1_020_000_000 }),
  });
  const budget = await subject.budget({ byteLength: 600_000_000, recordedMs: 60_000 });
  assert.equal(budget.level, "critical");
  assert.ok((budget.headroomMs ?? Infinity) < 120_000);
});

test("C — a manifest with no audio is reaped only when the caller says it was abandoned", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  // A tab killed during the microphone prompt: `begin` ran, no chunk followed.
  await subject.begin({ sessionId: "mtg-abandoned", payload: "{}" });
  // …and one this caller cannot judge at all.
  await subject.begin({ sessionId: "mtg-unknown", payload: "{}" });

  // Without the predicate nothing chunk-less is touched, which is the safe
  // default and what a caller that never opted in still gets.
  assert.deepEqual(await subject.reapOrphans(), []);
  assert.deepEqual((await subject.list()).map((record) => record.sessionId).sort(), ["mtg-abandoned", "mtg-unknown"]);

  assert.deepEqual(
    await subject.reapOrphans({ abandoned: (record) => record.sessionId === "mtg-abandoned" }),
    ["mtg-abandoned"],
  );
  assert.deepEqual((await subject.list()).map((record) => record.sessionId), ["mtg-unknown"]);
});

test("C — a chunk-less capture the caller is writing to survives the reap it runs beside", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-recording", payload: "{}" });
  // The predicate is asked about the manifest the reap has JUST read, which is
  // the only reading late enough to see a session another tab began after the
  // caller took its own listing.
  const seen: string[] = [];
  assert.deepEqual(
    await subject.reapOrphans({
      abandoned: (record) => {
        seen.push(record.sessionId);
        assert.equal(record.payload, "{}", "the caller is handed the payload it needs to judge");
        return false;
      },
    }),
    [],
  );
  assert.deepEqual(seen, ["mtg-recording"]);
  assert.ok(await subject.read("mtg-recording"));
});

test("C — the reap WAITS for an answer the caller has to ask the browser for", async () => {
  // The liveness answer on this host is `navigator.locks.query()`, which is a
  // promise. A reap that did not await the predicate would read the pending
  // promise as truthy and delete every chunk-less manifest, including the
  // recording another tab has open on its microphone prompt right now.
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-being-recorded", payload: "{}" });
  await subject.begin({ sessionId: "mtg-abandoned", payload: "{}" });

  assert.deepEqual(
    await subject.reapOrphans({
      abandoned: async (record) => {
        await Promise.resolve();
        return record.sessionId === "mtg-abandoned";
      },
    }),
    ["mtg-abandoned"],
  );
  assert.ok(await subject.read("mtg-being-recorded"), "the recording another tab is holding survives");
});

test("C — a capture that HAS audio is never reaped, whatever the caller says about it", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-live", payload: "{}" });
  await subject.appendChunk("mtg-live", audioBlob(64, 1));
  assert.deepEqual(await subject.reapOrphans({ abandoned: () => true }), []);
  assert.equal((await subject.read("mtg-live"))?.chunks.length, 1);
});

test("D6 — `keep` protects a record the caller alone knows is in use", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-in-hand", payload: "{}" });
  const settled = finalizeCapture(
    createCaptureSession({ id: "mtg-settled", scope: SCOPE }),
    "2026-08-11T10:00:00.000Z",
  );
  const settledPayload = serializeCapturePayload({ session: settled });
  await subject.begin({ sessionId: "mtg-settled", payload: settledPayload });
  await subject.setPayload("mtg-settled", settledPayload, { closed: true });

  // Both would be reaped — one as a settled capture, one as a chunk-less
  // manifest the caller called abandoned — and `keep` is the caller's one way to
  // say "not that one".
  assert.deepEqual(
    await subject.reapOrphans({ keep: ["mtg-in-hand", "mtg-settled"], abandoned: () => true }),
    [],
  );
  assert.ok(await subject.read("mtg-in-hand"));
  assert.ok(await subject.read("mtg-settled"));
  assert.deepEqual(await subject.reapOrphans({ abandoned: () => true }), ["mtg-in-hand", "mtg-settled"]);
});
