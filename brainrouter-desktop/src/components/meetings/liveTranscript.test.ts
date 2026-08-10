/**
 * ADR-035 D4/D5 — the fold, which is where "live text" is either safe or not.
 *
 * D4's rule reads like a UI detail and is not one: **a user editing settled text
 * must not have their edit overwritten by a late-arriving segment**. The
 * straightforward implementation — re-render the box from the session on every
 * update — passes every manual test and destroys a correction the moment the
 * next segment lands, twenty seconds later. So the fold is a pure function and
 * this is the test that holds it to the rule.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  appendSegment,
  createCaptureSession,
  markDone,
  markFailed,
  markTranscribing,
  MEETING_GAP_PHRASE,
  type MeetingCaptureSession,
} from "@kinqs/brainrouter-core/meetings";
import { EMPTY_TRANSCRIPT_FOLD, foldTranscript } from "./liveTranscript.js";

function capture(segments: number): MeetingCaptureSession {
  let session = createCaptureSession({ scope: { orgId: null }, title: "Sync", startedAt: "2026-08-10T09:00:00.000Z", id: "mtg-fold" });
  for (let index = 0; index < segments; index += 1) {
    session = appendSegment(session, { byteLength: 1_000, durationMs: 20_000 });
  }
  return session;
}

/** The attempts a segment has to spend before the shared policy stops retrying it. */
function exhaust(session: MeetingCaptureSession, index: number, reason: string): MeetingCaptureSession {
  let next = session;
  for (let attempt = 0; attempt < 4; attempt += 1) next = markFailed(next, index, reason);
  return next;
}

test("settled segments append in order and stop at the first one still in flight", () => {
  let session = capture(3);
  session = markDone(session, 0, "First twenty seconds.");
  // Segment 2 settles before segment 1 does — bounded concurrency makes that
  // ordinary. It must NOT jump the queue in the transcript.
  session = markDone(session, 2, "Third twenty seconds.");

  const first = foldTranscript("", session, EMPTY_TRANSCRIPT_FOLD);
  assert.equal(first.text, "First twenty seconds.");
  assert.equal(first.changed, true);

  session = markDone(session, 1, "Second twenty seconds.");
  const second = foldTranscript(first.text, session, first.fold);
  assert.equal(second.text, "First twenty seconds.\nSecond twenty seconds.\nThird twenty seconds.");

  // Nothing new: the caller can skip the state update entirely.
  assert.equal(foldTranscript(second.text, session, second.fold).changed, false);
});

test("a user's edit to settled text survives every later segment", () => {
  let session = capture(2);
  session = markDone(session, 0, "Spoke to Jon about the API.");
  const first = foldTranscript("", session, EMPTY_TRANSCRIPT_FOLD);

  // The whole point of live text: the user fixes the name WHILE the meeting is
  // still running, which is the moment §1 says today's design never offers.
  const corrected = "Spoke to John about the API.";
  session = markDone(session, 1, "Then we sized it.");
  const second = foldTranscript(corrected, session, first.fold);

  assert.equal(second.text, "Spoke to John about the API.\nThen we sized it.");
});

test("a gap waits while it is still going to be retried, and states itself once it is not", () => {
  let session = capture(2);
  session = markDone(session, 0, "Opening remarks.");
  session = markTranscribing(session, 1);
  session = markFailed(session, 1, "The endpoint rejected that audio.");

  // One failure is not a verdict — the shared queue will try again, so folding a
  // gap marker in now would put a lie in the box that a retry then contradicts.
  const waiting = foldTranscript("", session, EMPTY_TRANSCRIPT_FOLD);
  assert.equal(waiting.text, "Opening remarks.");

  session = exhaust(session, 1, "The endpoint rejected that audio.");
  const stated = foldTranscript(waiting.text, session, waiting.fold);
  assert.match(stated.text, new RegExp(MEETING_GAP_PHRASE));
  // D5 — with the time range, because that is what makes it actionable.
  assert.match(stated.text, /00:00:20–00:00:40/);
});

test("a gap that later transcribes is filled in, unless the user has touched it", () => {
  let session = exhaust(capture(1), 0, "The endpoint was unreachable.");
  const stated = foldTranscript("", session, EMPTY_TRANSCRIPT_FOLD);
  assert.match(stated.text, new RegExp(MEETING_GAP_PHRASE));

  // §6 — "retrying after the endpoint returns fills them in from the audio still
  // on disk". The marker this module wrote is the thing it replaces.
  session = markDone(markTranscribing(session, 0), 0, "The part we thought we had lost.");
  const filled = foldTranscript(stated.text, session, stated.fold);
  assert.equal(filled.text, "The part we thought we had lost.");

  // …but a box the user has rewritten is theirs. Rule 1 outranks the correction:
  // nothing is replaced, and the recovered text is not appended out of order.
  const owned = foldTranscript("I typed my own notes here.", session, stated.fold);
  assert.equal(owned.text, "I typed my own notes here.");
  assert.equal(owned.changed, false);
});

test("submitting states every unresolved segment as a gap rather than dropping it", () => {
  let session = capture(3);
  session = markDone(session, 0, "We agreed on the schema.");
  session = markTranscribing(session, 1);
  // Segment 2 has failed once and would ordinarily still be retried; the meeting
  // is being created now, so it never will be.
  session = markFailed(markTranscribing(session, 2), 2, "The endpoint rejected that audio.");

  const submitted = foldTranscript("We agreed on the schema.", session, { inserted: new Map([[0, "We agreed on the schema."]]), next: 1 }, { settleAll: true });

  assert.equal(
    submitted.text,
    `We agreed on the schema.\n[00:00:20–00:00:40 ${MEETING_GAP_PHRASE}]\n[00:00:40–00:01:00 ${MEETING_GAP_PHRASE}]`,
  );
});
