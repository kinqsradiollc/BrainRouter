/**
 * ADR-035 D1b — the two rules that make a browser capture store safe to build:
 * an id that cannot become a path, and a key that cannot reorder a meeting.
 *
 * These run with node:test + tsx (the dashboard has no workspace test script).
 * Nothing here needs a browser, which is the point of keeping these rules out of
 * the backends.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTURE_CHUNK_KEY_DIGITS,
  MAX_CAPTURE_MANIFEST_CHUNK_MS,
  MAX_CAPTURE_CHUNK_SEQUENCE,
  MIN_CAPTURE_MANIFEST_CHUNK_MS,
  assertCaptureSessionId,
  captureChunkKey,
  captureChunkSequence,
  captureManifestChunkMs,
  isCaptureManifestChunkMs,
  isCaptureSessionId,
  newCaptureSessionId,
  selectCaptureBackendKind,
} from "./captureStorage";

test("a session id that could escape its directory is refused", () => {
  for (const value of ["..", "../secrets", "a/b", "a\\b", ".hidden", "", " ", "a b", "a.b", "-leading"]) {
    assert.equal(isCaptureSessionId(value), false, `${JSON.stringify(value)} must not be a capture id`);
  }
  assert.equal(isCaptureSessionId("a".repeat(129)), false);
  assert.equal(isCaptureSessionId("a".repeat(128)), true);
  assert.throws(() => assertCaptureSessionId("../escape"), /letters, digits, dash or underscore/);
});

test("every minted id is one the store will accept", () => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const id = newCaptureSessionId();
    assert.equal(isCaptureSessionId(id), true, `minted an id the store would reject: ${id}`);
  }
});

test("ids stay unique and valid on the non-secure-context fallback", () => {
  // A plain-http origin has no `crypto.randomUUID`; the fallback is the only
  // reason recording works there at all, so it has to be a tested path too.
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
    assert.equal((globalThis as { crypto?: unknown }).crypto, undefined, "the fallback must actually be exercised");
    const ids = new Set(Array.from({ length: 500 }, () => newCaptureSessionId()));
    assert.equal(ids.size, 500);
    for (const id of ids) assert.equal(isCaptureSessionId(id), true, `invalid fallback id: ${id}`);
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("chunk keys sort as text exactly as they sort as numbers", () => {
  // OPFS lists a directory in an unspecified order, so this is what keeps an
  // hour of audio reassembling in the order it was spoken.
  const sequences = [0, 1, 2, 9, 10, 11, 99, 100, 101, 999, 1_000, 1_001, MAX_CAPTURE_CHUNK_SEQUENCE];
  const byText = sequences.map(captureChunkKey).sort();
  const byNumber = sequences.slice().sort((a, b) => a - b).map(captureChunkKey);
  assert.deepEqual(byText, byNumber);
});

test("a chunk key round-trips, and anything else in the directory is ignored", () => {
  assert.equal(captureChunkKey(0).length, CAPTURE_CHUNK_KEY_DIGITS + ".part".length);
  for (const sequence of [0, 7, 1_234, MAX_CAPTURE_CHUNK_SEQUENCE]) {
    assert.equal(captureChunkSequence(captureChunkKey(sequence)), sequence);
  }
  for (const name of ["manifest.json", "000001.json", "1.part", "0000001.part", "abcdef.part", ".part"]) {
    assert.equal(captureChunkSequence(name), undefined, `${name} must not read as a chunk`);
  }
});

test("a sequence outside the key's width is refused rather than silently truncated", () => {
  for (const sequence of [-1, 1.5, Number.NaN, MAX_CAPTURE_CHUNK_SEQUENCE + 1]) {
    assert.throws(() => captureChunkKey(sequence), /sequence must be an integer/);
  }
});

test("a persisted durability cadence is an integer in D9's range, with safe fallback for a damaged marker", () => {
  assert.equal(captureManifestChunkMs(undefined), undefined, "absence alone is the legacy signal");
  for (const value of [MIN_CAPTURE_MANIFEST_CHUNK_MS, 3_000, MAX_CAPTURE_MANIFEST_CHUNK_MS]) {
    assert.equal(isCaptureManifestChunkMs(value), true);
    assert.equal(captureManifestChunkMs(value), value);
  }
  for (const value of [null, "3000", 1_999, 5_001, 3_000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isCaptureManifestChunkMs(value), false);
    assert.equal(captureManifestChunkMs(value), 3_000, "a present-but-invalid marker remains D9, never legacy");
  }
});

test("OPFS is preferred, IndexedDB is the fallback, and neither is an answer", () => {
  assert.equal(selectCaptureBackendKind({ opfs: true, indexedDb: true }), "opfs");
  assert.equal(selectCaptureBackendKind({ opfs: true, indexedDb: false }), "opfs");
  assert.equal(selectCaptureBackendKind({ opfs: false, indexedDb: true }), "indexeddb");
  assert.equal(selectCaptureBackendKind({ opfs: false, indexedDb: false }), undefined);
});
