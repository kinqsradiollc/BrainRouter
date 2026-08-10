/**
 * ADR-035 D1b — the fallback ladder, and the refusal at the bottom of it.
 *
 * node:test + tsx. The candidates are supplied by the test, which is the whole
 * reason the ladder takes them as an argument: what is asserted here is the
 * order, the recovery from a candidate that opens and throws, and the fact that
 * a browser with no durable store gets an error at Record rather than a surprise
 * at Stop.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { FakeCaptureBackend } from "./_captureBackendFixture";
import type { CaptureStorageBackend } from "./captureStorage";
import {
  captureFallbackNotice,
  firstUsableCaptureBackend,
  openMeetingCaptureStore,
  type CaptureBackendCandidate,
} from "./openCaptureStore";

function working(kind: "opfs" | "indexeddb", opened: string[]): CaptureBackendCandidate {
  return {
    kind,
    create: async (): Promise<CaptureStorageBackend> => {
      opened.push(kind);
      return new FakeCaptureBackend({ kind });
    },
  };
}

function broken(kind: "opfs" | "indexeddb", reason: string): CaptureBackendCandidate {
  return {
    kind,
    create: async (): Promise<CaptureStorageBackend> => {
      throw new Error(reason);
    },
  };
}

test("the first candidate that opens wins, and later ones are never touched", async () => {
  const opened: string[] = [];
  const selection = await firstUsableCaptureBackend([working("opfs", opened), working("indexeddb", opened)]);
  assert.equal(selection.backend.kind, "opfs");
  assert.deepEqual(opened, ["opfs"]);
  assert.deepEqual(selection.rejected, []);
});

test("a candidate that exists and then throws falls through to the next", async () => {
  // The private-window case: both APIs are present and neither can be opened.
  const opened: string[] = [];
  const selection = await firstUsableCaptureBackend([
    broken("opfs", "quota policy refused the write"),
    working("indexeddb", opened),
  ]);
  assert.equal(selection.backend.kind, "indexeddb");
  assert.deepEqual(opened, ["indexeddb"]);
  assert.deepEqual(selection.rejected, [{ kind: "opfs", error: "quota policy refused the write" }]);
});

test("no durable store is a loud failure carrying every reason", async () => {
  await assert.rejects(
    () => firstUsableCaptureBackend([broken("opfs", "no OPFS"), broken("indexeddb", "no IndexedDB")]),
    (error: Error) => {
      assert.match(error.message, /no durable place to store a recording/);
      assert.match(error.message, /opfs: no OPFS/);
      assert.match(error.message, /indexeddb: no IndexedDB/);
      return true;
    },
  );
});

test("an empty candidate list fails too — there is no memory-backed consolation prize", async () => {
  await assert.rejects(() => firstUsableCaptureBackend([]), /no durable place to store a recording/);
});

test("opening reports which store was used and whether it can be evicted", async () => {
  const opened: string[] = [];
  const result = await openMeetingCaptureStore({
    candidates: [broken("opfs", "unavailable"), working("indexeddb", opened)],
    persistence: { persisted: async () => false, persist: async () => true },
    estimate: async () => ({ usage: 1, quota: 1_000_000 }),
  });
  assert.equal(result.kind, "indexeddb");
  assert.equal(result.persisted, true);
  assert.deepEqual(result.rejected.map((attempt) => attempt.kind), ["opfs"]);
  assert.equal((await result.store.budget()).level, "ok");
});

test("falling back to IndexedDB is something the recorder is told, with the reason", async () => {
  const notice = captureFallbackNotice({
    kind: "indexeddb",
    rejected: [{ kind: "opfs", error: "quota policy refused the write" }],
  });
  assert.match(notice, /browser's database/);
  assert.match(notice, /quota policy refused the write/);
});

test("the preferred store says nothing, and neither does a fallback nobody fell back from", async () => {
  // A notice on the happy path is noise, and noise is what makes the real
  // warning ignorable.
  assert.equal(captureFallbackNotice({ kind: "opfs", rejected: [] }), "");
  assert.equal(captureFallbackNotice({ kind: "opfs", rejected: [{ kind: "indexeddb", error: "x" }] }), "");
  assert.equal(captureFallbackNotice({ kind: "indexeddb", rejected: [] }), "");
});

test("a refused persistence request does not stop the store opening", async () => {
  const opened: string[] = [];
  const result = await openMeetingCaptureStore({
    candidates: [working("opfs", opened)],
    persistence: { persisted: async () => false, persist: async () => false },
    estimate: async () => ({ usage: 1, quota: 1_000_000 }),
  });
  assert.equal(result.persisted, false);
  assert.match((await result.store.budget()).message, /persistent storage/);
});
