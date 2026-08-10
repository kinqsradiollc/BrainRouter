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
  reconcileCaptureDraft,
  stopCapture,
  type MeetingCaptureSession,
} from "@kinqs/brainrouter-core/meetings";

import {
  appendTranscriptSync,
  beginTranscriptSync,
  healTranscriptGaps,
  nextTranscriptSync,
  pendingTranscriptText,
  settleTranscriptForSubmit,
  submitTranscript,
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

// ── D5 at submit: the last moment an unmarked hole can be refused ─────────────

test("creating the meeting states an unsettled segment as a gap, not as silence", () => {
  // THE reproduction. Segment 1 never transcribed, so `transcriptText` drops it
  // and the two sentences either side read as contiguous speech — D5's "quietly
  // wrong" transcript, POSTed and then summarized, with the audio deleted on the
  // next line.
  let session = markDone(withSegments(3), 0, "first twenty seconds");
  session = markDone(session, 2, "third twenty seconds");
  session = stopCapture(session);
  let state = beginTranscriptSync("");
  const composed = nextTranscriptSync(state, session, "");
  state = composed.state;
  assert.equal(composed.text, "first twenty seconds\nthird twenty seconds", "what the box holds while it is still coming");

  const submitted = settleTranscriptForSubmit(state, session, composed.text ?? "");
  assert.equal(
    submitted.text,
    "first twenty seconds\n[00:00:20–00:00:40 could not be transcribed]\nthird twenty seconds",
  );
  assert.deepEqual(submitted.stated, [1]);
});

test("submitTranscript IS the posted text — a provisional segment cannot reach the server as silence", () => {
  // The page posts this return value directly, with no local in between. That
  // shape exists because of the mutation that survived the last round: the page
  // settled into a `let transcript = draftTranscript` and posted the identifier,
  // so deleting the one assignment restored the unmarked hole with every
  // assertion still green. This test binds on the VALUE — delete the delegation
  // below (return the box unchanged) and the meeting goes to the server missing
  // twenty seconds with nothing saying so, which is exactly what fails here.
  let session = markDone(withSegments(3), 0, "first twenty seconds");
  session = markDone(session, 2, "third twenty seconds");
  session = stopCapture(session);
  let state = beginTranscriptSync("");
  const composed = nextTranscriptSync(state, session, "");
  state = composed.state;
  const box = composed.text ?? "";
  assert.equal(box, "first twenty seconds\nthird twenty seconds", "the box while it is still coming");

  const posted = submitTranscript(state, session, box);
  assert.equal(
    posted.text,
    "first twenty seconds\n[00:00:20–00:00:40 could not be transcribed]\nthird twenty seconds",
  );
  assert.notEqual(posted.text, box, "what is posted is never simply the box");
  assert.deepEqual(posted.stated, [1]);
});

test("submitTranscript posts a pasted transcript untouched, and claims nothing about it", () => {
  // The no-capture case, which used to be the whole reason for the mutable
  // local. `stated` is empty because there is no segment that could have failed
  // — not because the queue finished.
  const state = beginTranscriptSync("");
  const posted = submitTranscript(state, null, "pasted notes from the call");
  assert.equal(posted.text, "pasted notes from the call");
  assert.deepEqual(posted.stated, []);
  assert.equal(posted.state, state, "nothing to advance");
});

test("settling at submit does not disturb a transcript that already finished", () => {
  let session = markDone(markDone(withSegments(2), 0, "first"), 1, "second");
  session = stopCapture(session);
  let state = beginTranscriptSync("");
  const composed = nextTranscriptSync(state, session, "");
  state = composed.state;
  const submitted = settleTranscriptForSubmit(state, session, composed.text ?? "");
  assert.equal(submitted.text, "first\nsecond");
  assert.deepEqual(submitted.stated, []);
});

test("an edited box keeps its edits and gains the gaps at submit", () => {
  // The person owns the box, so the append-only rule still applies — but the
  // segment that never transcribed is still stated rather than dropped.
  let session = markDone(withSegments(2), 0, "first");
  session = stopCapture(session);
  let state = beginTranscriptSync("");
  state = nextTranscriptSync(state, session, "").state;
  state = nextTranscriptSync(state, session, "first, corrected by hand").state;
  assert.equal(state.dirty, true);

  const submitted = settleTranscriptForSubmit(state, session, "first, corrected by hand");
  assert.equal(submitted.text, "first, corrected by hand\n[00:00:20–00:00:40 could not be transcribed]");
  assert.deepEqual(submitted.stated, [1]);
});

test("a keystroke that submit beat to the sync effect is still treated as an edit", () => {
  // Submit can be the very next thing after typing, and the effect that would
  // have set `dirty` runs after the render. Recomposing here would delete the
  // words the person had just typed.
  let session = markDone(withSegments(2), 0, "first");
  session = stopCapture(session);
  let state = beginTranscriptSync("");
  state = nextTranscriptSync(state, session, "").state;
  assert.equal(state.dirty, false);

  const submitted = settleTranscriptForSubmit(state, session, "first\nand a note nobody has seen yet");
  assert.match(submitted.text, /and a note nobody has seen yet/);
  assert.equal(submitted.state.dirty, true);
});

// ── D4/§6: the restored draft and the recovered session both hold the meeting ─

test("picking a recovered capture back up does not compose the meeting twice", () => {
  // §6's kill-and-reopen, from this host's side. The draft came back holding the
  // transcript, and `composeCaptureTranscript` appends the WHOLE transcript to
  // its base — so composing over the draft produced the meeting twice, POSTed it
  // and summarized it. Composition resumes over `retained` instead.
  let session = markDone(markDone(withSegments(2), 0, "first"), 1, "second");
  session = stopCapture(session);
  const draft = "a note I typed before recording\nfirst\nsecond";
  const reconciled = reconcileCaptureDraft(draft, session);

  const state = {
    base: reconciled.retained,
    written: reconciled.text,
    included: reconciled.accounted,
    dirty: reconciled.userOwned.length > 0,
  };
  assert.equal(state.dirty, false, "nothing was edited, so automatic composition stays on");
  const next = nextTranscriptSync(state, session, reconciled.text);
  const settled = next.text ?? reconciled.text;
  assert.equal(settled.match(/first/g)?.length, 1);
  assert.equal(settled.match(/second/g)?.length, 1);
  assert.match(settled, /a note I typed before recording/);

  // The old behaviour, asserted so this test cannot quietly stop proving
  // anything: composing over the raw draft is still the doubling.
  const doubled = nextTranscriptSync(beginTranscriptSync(draft), session, draft);
  assert.equal(doubled.text?.match(/first/g)?.length, 2);
});

test("a recovered capture whose text the person edited switches to append-only", () => {
  // `nextTranscriptSync` RECOMPOSES `base + transcriptText(session)` on every
  // drain, so leaving automatic composition on here would restore the pre-edit
  // wording of the segment they fixed.
  let session = markDone(markDone(withSegments(2), 0, "the wrong name"), 1, "second");
  session = stopCapture(session);
  const draft = "the right name\nsecond";
  const reconciled = reconcileCaptureDraft(draft, session);
  assert.deepEqual(reconciled.userOwned, [0]);

  const state = {
    base: reconciled.retained,
    written: reconciled.text,
    included: reconciled.accounted,
    dirty: reconciled.userOwned.length > 0,
  };
  assert.equal(state.dirty, true);
  assert.equal(nextTranscriptSync(state, session, reconciled.text).text, undefined, "their wording stands");
});
