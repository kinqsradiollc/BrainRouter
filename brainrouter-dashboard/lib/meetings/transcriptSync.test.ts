/**
 * ADR-035 D4 — "a user editing settled text must not have their edit overwritten
 * by a late-arriving segment."
 *
 * The shared model already refuses a duplicate result for a settled segment. The
 * defect these tests exist to catch is the SECOND writer: this surface composes
 * the whole transcript into the compose box on every drain, and would happily
 * replace a sentence somebody just fixed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  appendSegment,
  createCaptureSession,
  markDone,
  markFailed,
  type MeetingCaptureSession,
} from "@kinqs/brainrouter-core/meetings";

import {
  appendTranscriptSync,
  beginTranscriptSync,
  healTranscriptGaps,
  nextTranscriptSync,
  pendingTranscriptText,
  transcriptRevisionPending,
} from "./transcriptSync";

function withSegments(count: number): MeetingCaptureSession {
  let session = createCaptureSession({ id: "mtg-1", scope: { orgId: null } });
  for (let index = 0; index < count; index += 1) {
    session = appendSegment(session, { byteLength: 100, durationMs: 20_000 });
  }
  return session;
}

test("text appears in the box during the meeting, as segments settle", () => {
  let state = beginTranscriptSync("");
  const first = markDone(withSegments(2), 0, "hello there");
  const step = nextTranscriptSync(state, first, "");
  state = step.state;
  assert.equal(step.text, "hello there");

  const second = markDone(first, 1, "and the rest");
  const next = nextTranscriptSync(state, second, "hello there");
  assert.equal(next.text, "hello there\nand the rest");
});

test("pressing Record does not delete what was already pasted in the box", () => {
  let state = beginTranscriptSync("pasted notes");
  const session = markDone(withSegments(1), 0, "spoken words");
  const step = nextTranscriptSync(state, session, "pasted notes");
  state = step.state;
  assert.equal(step.text, "pasted notes\nspoken words");
});

test("once a person types, a later segment never replaces the box again", () => {
  let state = beginTranscriptSync("");
  const one = markDone(withSegments(2), 0, "raw transcription");
  state = nextTranscriptSync(state, one, "").state;

  // The user corrects a name.
  state = nextTranscriptSync(state, one, "corrected transcription").state;
  assert.equal(state.dirty, true);

  const two = markDone(one, 1, "a late segment");
  const after = nextTranscriptSync(state, two, "corrected transcription");
  assert.equal(after.text, undefined);
  assert.equal(after.state.dirty, true);
});

test("what the edit is holding back is offered, never silently withheld", () => {
  let state = beginTranscriptSync("");
  const one = markDone(withSegments(3), 0, "first");
  state = nextTranscriptSync(state, one, "").state;
  state = nextTranscriptSync(state, one, "first, edited").state;

  const two = markDone(markDone(one, 1, "second"), 2, "third");
  assert.equal(pendingTranscriptText(two, state.included), "second\nthird");

  const appended = appendTranscriptSync(state, two, "first, edited");
  assert.equal(appended.text, "first, edited\nsecond\nthird");
  // Still theirs: appending must not re-arm the automatic replacement.
  assert.equal(appended.state.dirty, true);
  assert.equal(pendingTranscriptText(two, appended.state.included), "");
});

test("a gap is offered too — an unmarked hole is what D5 refuses", () => {
  let state = beginTranscriptSync("");
  let session = markDone(withSegments(2), 0, "the part that worked");
  state = nextTranscriptSync(state, session, "").state;
  state = nextTranscriptSync(state, session, "the part that worked, edited").state;

  session = markFailed(session, 1, "the endpoint gave up");
  assert.match(pendingTranscriptText(session, state.included), /00:00:20–00:00:40 could not be transcribed/);
});

test("a gap the retry filled in is replaced where it stands, not appended at the end", () => {
  // D5, after the user has edited. The box already claims a range could not be
  // transcribed; a retry proved otherwise. Appending the recovered words at the
  // end would leave the false claim standing AND put the text out of order.
  let state = beginTranscriptSync("");
  let session = markDone(markFailed(markDone(withSegments(3), 0, "first"), 1, "gave up"), 2, "third");
  state = nextTranscriptSync(state, session, "").state;
  const edited = "first, edited\n[00:00:20–00:00:40 could not be transcribed]\nthird";
  state = nextTranscriptSync(state, session, edited).state;
  assert.equal(state.dirty, true);

  session = markDone(
    { ...session, segments: [session.segments[0]!, { ...session.segments[1]!, state: "pending" }, session.segments[2]!] },
    1,
    "the recovered middle",
  );
  assert.equal(transcriptRevisionPending(state, session, edited), true);
  const revised = appendTranscriptSync(state, session, edited);
  assert.equal(revised.text, "first, edited\nthe recovered middle\nthird");
});

test("healing only ever touches a marker this surface wrote verbatim", () => {
  // The safety property: an exact-match replace can never rewrite prose a person
  // typed, because their line no longer matches.
  let session = markDone(markFailed(withSegments(2), 1, "gave up"), 0, "first");
  const rephrased = "first\n[the bit about the budget was inaudible]";
  assert.equal(healTranscriptGaps(session, rephrased), rephrased);

  session = markDone(
    { ...session, segments: [session.segments[0]!, { ...session.segments[1]!, state: "pending" }] },
    1,
    "recovered",
  );
  assert.equal(healTranscriptGaps(session, rephrased), rephrased);
});

test("a segment still in flight contributes nothing rather than a placeholder", () => {
  const state = beginTranscriptSync("");
  const session = markDone(withSegments(2), 0, "settled");
  assert.equal(nextTranscriptSync(state, session, "").text, "settled");
  assert.equal(pendingTranscriptText(session, []), "settled");
});
