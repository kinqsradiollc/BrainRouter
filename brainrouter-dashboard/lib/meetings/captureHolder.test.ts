/**
 * ADR-035 D6 — the holder id, which is the only thing the shared lease needs
 * from this host and the one thing it cannot mint for itself.
 *
 * Two properties matter and they pull against each other, which is why the
 * storage choice is a decision rather than a detail: one id per TAB (or two tabs
 * read each other's leases as their own and every guard answers "that is me"),
 * and the SAME id across a reload (or a tab that refreshed mid-recording has to
 * wait the staleness window out before it can touch the recording it was making
 * a second ago).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { MEETING_CAPTURE_HOLDER_KEY, readCaptureHolderId, type CaptureHolderStorage } from "./captureHolder";

function memoryStorage(seed: Record<string, string> = {}): CaptureHolderStorage & { readonly values: Map<string, string> } {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

test("a reloaded tab gets the SAME id, so it reclaims its own lease at once", () => {
  const storage = memoryStorage();
  const first = readCaptureHolderId(storage);
  assert.match(first, /^wr-/);
  assert.equal(storage.values.get(MEETING_CAPTURE_HOLDER_KEY), first, "it is written down, not merely returned");
  assert.equal(readCaptureHolderId(storage), first, "and read back rather than minted again");
});

test("a second TAB gets a different id, which is the whole reason the id exists", () => {
  // `sessionStorage` is per tab; this is that fact expressed as two storages.
  const ids = new Set(Array.from({ length: 32 }, () => readCaptureHolderId(memoryStorage())));
  assert.equal(ids.size, 32, "every tab is a different writer");
});

test("a browser that refuses storage still names its writer", () => {
  // Private mode, partitioned storage, a blocked origin. A holder id that could
  // not be produced would mean no lease at all, and no lease is how a live
  // recording gets deleted — so every failure degrades to a fresh id.
  assert.match(readCaptureHolderId(null), /^wr-/);
  const unreadable: CaptureHolderStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {},
  };
  assert.match(readCaptureHolderId(unreadable), /^wr-/);
  const unwritable: CaptureHolderStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
  };
  const minted = readCaptureHolderId(unwritable);
  assert.match(minted, /^wr-/);
  assert.notEqual(readCaptureHolderId(unwritable), minted, "unwritable means unremembered, and it says so rather than pretending");
});

test("a stored value that is not an id is replaced rather than trusted", () => {
  const storage = memoryStorage({ [MEETING_CAPTURE_HOLDER_KEY]: "" });
  const id = readCaptureHolderId(storage);
  assert.match(id, /^wr-/);
  assert.equal(storage.values.get(MEETING_CAPTURE_HOLDER_KEY), id);
});
