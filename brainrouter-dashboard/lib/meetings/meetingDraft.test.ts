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

import {
  appendSegment,
  beginTranscriptFold,
  createCaptureSession,
  foldTranscript,
  formatCaptureGap,
  markDone,
  markFailed,
  reconcileCaptureDraft,
  settleTranscriptForSubmit,
  stopCapture,
  type MeetingCaptureSession,
} from "@kinqs/brainrouter-core/meetings";

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

// ── §6, from this host's side: kill the tab, reopen it, get the box back ──────
//
// The three tests below drive the page's whole composition wiring — persist the
// box, read it back, `reconcileCaptureDraft` → `beginTranscriptFold` →
// `foldTranscript` → `settleTranscriptForSubmit` — over the real store. The
// rules are the shared module's and are tested there; what is being asserted
// here is that THIS host's durable half feeds them the one input they can
// reconcile: the compose box whole. A draft that comes back short, stripped or
// re-serialized wrongly is indistinguishable, to every function downstream,
// from a box that never held the transcript at all — and the failure is silent,
// which is why it is asserted as text a person could have typed rather than as
// a field's shape.

function captured(count: number): MeetingCaptureSession {
  let session = createCaptureSession({ id: "mtg-1", scope: { orgId: null } });
  for (let index = 0; index < count; index += 1) {
    session = appendSegment(session, { byteLength: 100, durationMs: 20_000 });
  }
  return session;
}

/** A segment that failed and has since been retried into text. */
function recovered(session: MeetingCaptureSession, index: number, text: string): MeetingCaptureSession {
  const segments = session.segments.map((segment, at) => (at === index ? { ...segment, state: "pending" as const } : segment));
  return markDone({ ...session, segments }, index, text);
}

/** The kill: what the debounced autosave wrote is all the next tab has. */
async function reopen(subject: MeetingCaptureStore, transcript: string): Promise<string> {
  await writeMeetingDraft(subject, { ...DRAFT, transcript });
  return (await readMeetingDraft(subject)).transcript;
}

test("§6 — a note typed between two segments is still between them after the kill", async () => {
  // The reproduction this host's recompose model produced: `base` was the box
  // with every segment stripped out of it, so recomposing put ALL of the
  // person's own words first and the meeting after them —
  // `"S1\nMy note\nS2\nS3"` reopened as `"My note\nS1\nS2\nS3"`, autosaved,
  // POSTed and summarized. Position in that box is the person's.
  //
  // The box carries a blank line and a trailing newline on purpose. "The box
  // whole" is a claim about bytes, not about content: a draft that comes back
  // tidied — blank lines dropped, ends trimmed — no longer line-matches the
  // segments it holds, and the frontier rule then reads perfectly good text as
  // never-folded and appends the meeting a second time under it.
  const session = markDone(markDone(markDone(captured(3), 0, "S1"), 1, "S2"), 2, "S3");
  const box = "an agenda I pasted before recording\n\nS1\nMy note\nS2\nS3\n";

  const restored = await reopen(store(), box);
  assert.equal(restored, box, "byte for byte, blank lines and all");
  const reconciled = reconcileCaptureDraft(restored, session);
  const folded = foldTranscript(reconciled.text, session, beginTranscriptFold(reconciled));

  assert.equal(folded.changed, false, "the box already holds the whole meeting");
  assert.equal(folded.text, box, "and every line of it is exactly where it was left");
  assert.notEqual(folded.text, "an agenda I pasted before recording\nMy note\nS1\nS2\nS3");
  // Folded once, not twice — the doubling `EMPTY_TRANSCRIPT_FOLD` would cause.
  for (const line of ["an agenda I pasted before recording", "S1", "My note", "S2", "S3"]) {
    assert.equal(folded.text.split("\n").filter((held) => held === line).length, 1, `${line} appears once`);
  }
});

test("§6 — an edit to the last settled segment is never reverted and never relocated", async () => {
  // The second reproduction: `"S1\nS2\nS3 corrected"` came back
  // `"S3 corrected\nS1\nS2\nS3"` — the pre-edit wording restored INTO the
  // meeting and the correction moved to the top.
  //
  // What an append-only fold does instead is the honest limit stated in the
  // shared module: an edit to the LAST settled segment leaves no anchor after
  // it, so that segment reads as never-folded and is appended once more. The
  // person's wording still stands, first, with a duplicate line under it they
  // can delete — which is the safe direction of the two.
  const session = markDone(markDone(markDone(captured(3), 0, "S1"), 1, "S2"), 2, "S3");
  const box = "S1\nS2\nS3 corrected";

  const restored = await reopen(store(), box);
  const reconciled = reconcileCaptureDraft(restored, session);
  const folded = foldTranscript(reconciled.text, session, beginTranscriptFold(reconciled));

  assert.equal(folded.text.startsWith(box), true, "their box is the head of the result, untouched");
  assert.equal(folded.text, "S1\nS2\nS3 corrected\nS3");
  assert.notEqual(folded.text, "S3 corrected\nS1\nS2\nS3");
});

test("§6 — a gap stated before the kill is healed where it stands, and submit states the rest", async () => {
  // D5 both ways round. The box came back claiming a range could not be
  // transcribed; the retry that ran while the tab was gone proved otherwise, so
  // the claim is corrected IN PLACE rather than the recovered words being
  // appended at the end with the false claim left standing above them.
  const gap = formatCaptureGap(20_000, 40_000);
  const failed = markDone(markFailed(markDone(captured(3), 0, "S1"), 1, "gave up"), 2, "S3");
  const box = `S1\n${gap}\nS3`;

  const restored = await reopen(store(), box);
  assert.equal(restored, box, "the marker survives the store verbatim, or nothing can match it");

  const session = stopCapture(recovered(failed, 1, "the recovered middle"));
  const reconciled = reconcileCaptureDraft(restored, session);
  assert.equal(reconciled.text, "S1\nthe recovered middle\nS3", "replaced where it sat");

  const folded = foldTranscript(reconciled.text, session, beginTranscriptFold(reconciled));
  assert.equal(folded.text, "S1\nthe recovered middle\nS3", "and nothing is appended after it");

  // …and the segment still in flight when the tab died is STATED at submit
  // rather than left as an unmarked hole, because the audio is deleted next.
  //
  // The box is `"S1"` and not `"S1\nS3"`, which is the fold's doing rather than
  // this test's convenience: it stops at the first segment that could still
  // change on its own, so a killed tab's draft never contains a hole for a
  // reopened one to misread as a deleted line.
  const stillOut = stopCapture(markDone(markDone(captured(3), 0, "S1"), 2, "S3"));
  const opened = await reopen(store(), "S1");
  const started = reconcileCaptureDraft(opened, stillOut);
  const submitted = settleTranscriptForSubmit(started.text, stillOut, beginTranscriptFold(started));
  assert.equal(submitted.text, `S1\n${gap}\nS3`);
  assert.deepEqual(submitted.stated, [1]);
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
