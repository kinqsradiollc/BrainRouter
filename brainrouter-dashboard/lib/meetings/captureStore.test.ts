/**
 * ADR-035 D1b — the durable capture protocol, exercised where the decisions are.
 *
 * These run directly with node:test + tsx, the same way the dashboard's other
 * tests do (the workspace has no test script). Neither OPFS nor IndexedDB exists
 * here, which is exactly why `MeetingCaptureStore` holds all of the logic and the
 * two backends hold none: everything asserted below is behaviour the real store
 * performs against the real seam, not behaviour a mock performs against itself.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { audioBlob, FakeCaptureBackend } from "./_captureBackendFixture";
import { MeetingCaptureStore, MEETING_CAPTURE_TIMESLICE_MS, type MeetingCaptureStoreOptions } from "./captureStore";

function store(backend = new FakeCaptureBackend(), options: MeetingCaptureStoreOptions = {}): MeetingCaptureStore {
  return new MeetingCaptureStore(backend, options);
}

test("the chunk cadence stays inside the ADR's 15–30s range", () => {
  assert.ok(MEETING_CAPTURE_TIMESLICE_MS >= 15_000 && MEETING_CAPTURE_TIMESLICE_MS <= 30_000);
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

test("an empty chunk is refused", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "mtg-1" });
  await assert.rejects(() => subject.appendChunk("mtg-1", new Blob([])), /at least one byte/);
  assert.deepEqual(await subject.resumable(), [], "a session of empty chunks is not offered back");
});

test("an unsafe session id never reaches the backend", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  for (const id of ["../escape", "a/b", "", ".", "has space"]) {
    await assert.rejects(() => subject.begin({ sessionId: id }), /letters, digits, dash or underscore/);
  }
  assert.deepEqual(backend.calls, []);
});

test("attach resumes an existing capture and continues its numbering", async () => {
  const backend = new FakeCaptureBackend();
  const first = store(backend);
  await first.begin({ sessionId: "mtg-1" });
  await first.appendChunk("mtg-1", audioBlob(8, 1));
  await first.appendChunk("mtg-1", audioBlob(8, 2));

  // A fresh store is what a reloaded tab gets: no in-memory sequence counter.
  const second = store(backend);
  const record = await second.attach("mtg-1");
  assert.equal(record.byteLength, 16);
  const next = await second.appendChunk("mtg-1", audioBlob(8, 3));
  assert.equal(next.sequence, 2);
});

test("attaching a capture that is not stored fails rather than inventing one", async () => {
  await assert.rejects(() => store().attach("mtg-missing"), /No meeting capture/);
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

  assert.deepEqual((await subject.resumable()).map((record) => record.sessionId), ["new", "old"]);
});

test("the payload round-trips without the store looking inside it", async () => {
  const subject = store();
  await subject.begin({ sessionId: "mtg-1", payload: '{"segments":[]}' });
  const updated = await subject.setPayload("mtg-1", '{"segments":[{"index":0}]}');
  assert.equal(updated.payload, '{"segments":[{"index":0}]}');
  assert.equal(updated.closed, false, "settling is a separate, explicit decision");
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

test("reaping deletes only captures the caller does not know about, and names them", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await subject.begin({ sessionId: "known" });
  await subject.appendChunk("known", audioBlob(4, 1));
  await subject.begin({ sessionId: "orphan" });
  await subject.appendChunk("orphan", audioBlob(4, 2));

  assert.deepEqual(await subject.reapOrphans(["known"]), ["orphan"]);
  assert.deepEqual(await subject.listStoredSessionIds(), ["known"]);
});

test("reaping clears leftovers this model would never have minted", async () => {
  // Something else wrote into the capture root. Refusing to reap it because the
  // name fails the id shape would leave quota consumed by data nobody owns.
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await backend.writeChunk("not a valid id", 0, audioBlob(4, 1));
  assert.deepEqual(await subject.reapOrphans([]), ["not a valid id"]);
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
