/**
 * ADR-035 D6 — "the existing text draft should move to the same protected
 * location", and the two ways a move like this is usually not a move.
 *
 * The first is leaving the original where it was, which makes a copy rather than
 * a move — and the words this decision is about would still be in
 * `localStorage`. The second is the draft and the capture manifest both claiming
 * the same sentences, which is what made a recovered meeting come back doubled.
 *
 * Driven against the real `MeetingCaptureStore` over the same in-memory backend
 * the capture tests use, because the draft's whole claim is that it lives where
 * the audio lives.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { audioBlob, FakeCaptureBackend } from "./_captureBackendFixture";
import { resumableCaptures } from "./capturePayload";
import { MeetingCaptureStore } from "./captureStore";
import {
  clearMeetingDraft,
  isEmptyMeetingDraft,
  LEGACY_MEETING_DRAFT_KEY,
  MEETING_DRAFT_CAPTURE_ID,
  parseMeetingDraft,
  readMeetingDraft,
  takeLegacyMeetingDraft,
  writeMeetingDraft,
  type LegacyDraftStorage,
} from "./meetingDraft";

const DRAFT = { title: "Weekly product sync", transcript: "a note I typed", language: "ja", template: "standup" };

function store(backend = new FakeCaptureBackend()): MeetingCaptureStore {
  return new MeetingCaptureStore(backend);
}

function fakeStorage(entries: Record<string, string> = {}): LegacyDraftStorage & { readonly held: Map<string, string> } {
  const held = new Map(Object.entries(entries));
  return {
    held,
    getItem: (key) => held.get(key) ?? null,
    removeItem: (key) => { held.delete(key); },
  };
}

test("the draft round-trips through the store the audio lives in", async () => {
  const subject = store();
  await writeMeetingDraft(subject, DRAFT);
  assert.deepEqual(await readMeetingDraft(subject), DRAFT);

  // …and a second save updates it rather than colliding with the record the
  // first one created.
  await writeMeetingDraft(subject, { ...DRAFT, title: "Renamed" });
  assert.equal((await readMeetingDraft(subject)).title, "Renamed");
});

test("two debounced saves that reach the store together both succeed", async () => {
  // `setPayload` refuses a record that does not exist and `begin` refuses one
  // that does, so the very first save is the one moment two writers can collide.
  const subject = store();
  await Promise.all([
    writeMeetingDraft(subject, DRAFT),
    writeMeetingDraft(subject, { ...DRAFT, title: "The other one" }),
  ]);
  const held = await readMeetingDraft(subject);
  assert.ok(held.title === DRAFT.title || held.title === "The other one");
  assert.equal(held.transcript, DRAFT.transcript);
});

test("an emptied draft is deleted, not blanked", async () => {
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await writeMeetingDraft(subject, DRAFT);
  await writeMeetingDraft(subject, { title: "", transcript: "", language: "en", template: "general" });
  assert.equal(backend.manifests.has(MEETING_DRAFT_CAPTURE_ID), false, "nothing is left behind to read");
  assert.equal(isEmptyMeetingDraft(await readMeetingDraft(subject)), true);
});

test("the draft is never offered back as a meeting, and the reap cannot take it", async () => {
  // Two invariants that make the reserved id safe to keep in the store's own
  // listing: it holds no audio, and its manifest is never closed.
  const backend = new FakeCaptureBackend();
  const subject = store(backend);
  await writeMeetingDraft(subject, DRAFT);
  await subject.begin({ sessionId: "mtg-real" });
  await subject.appendChunk("mtg-real", audioBlob(64, 1));

  const offered = resumableCaptures(await subject.list(), { scope: { orgId: null } });
  assert.deepEqual(offered.map((entry) => entry.record.sessionId), ["mtg-real"]);
  assert.deepEqual(await subject.reapOrphans(), []);
  assert.deepEqual(await readMeetingDraft(subject), DRAFT, "the draft survived the reap");
});

test("an unreadable draft degrades to no draft rather than to an exception", async () => {
  const subject = store();
  await subject.begin({ sessionId: MEETING_DRAFT_CAPTURE_ID, payload: "<<<not json" });
  assert.equal(isEmptyMeetingDraft(await readMeetingDraft(subject)), true);
  assert.deepEqual(parseMeetingDraft('{"title":42}'), { title: "", transcript: "", language: "", template: "" });
});

test("clearing a draft that was never written is not an error the page has to handle", async () => {
  await assert.doesNotReject(() => clearMeetingDraft(store()));
});

test("the legacy draft is READ AND REMOVED — a copy left behind is not a move", () => {
  const storage = fakeStorage({
    [LEGACY_MEETING_DRAFT_KEY]: JSON.stringify({ title: "Old", transcript: "two minutes of meeting", language: "en" }),
  });
  const taken = takeLegacyMeetingDraft(storage);
  assert.equal(taken?.title, "Old");
  assert.equal(taken?.transcript, "two minutes of meeting");
  assert.equal(taken?.template, "", "a field the old shape did not carry is empty, never undefined");
  assert.equal(storage.held.has(LEGACY_MEETING_DRAFT_KEY), false);
  assert.equal(takeLegacyMeetingDraft(storage), null, "and there is nothing left to migrate twice");
});

test("a legacy value too damaged to read is still taken out of localStorage", () => {
  // D6's objection is to the words being there at all, and a payload we cannot
  // parse is still the meeting content.
  const storage = fakeStorage({ [LEGACY_MEETING_DRAFT_KEY]: "{not json" });
  assert.equal(takeLegacyMeetingDraft(storage), null);
  assert.equal(storage.held.has(LEGACY_MEETING_DRAFT_KEY), false);
});

test("a storage that refuses to answer does not stop the page", () => {
  const hostile: LegacyDraftStorage = {
    getItem() { throw new Error("access denied"); },
    removeItem() { throw new Error("access denied"); },
  };
  assert.equal(takeLegacyMeetingDraft(hostile), null);
});
