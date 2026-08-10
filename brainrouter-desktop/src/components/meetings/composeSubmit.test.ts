/**
 * ADR-035 D5 — the value that is actually POSTED, and the click that must not
 * post one.
 *
 * Both were reproduced, and both were invisible: deleting the settle step left
 * all 46 renderer tests and the 178-line source contract green while the meeting
 * lost a gap marker and the twenty seconds behind it, and clicking Create 4 ms
 * after Stop posted a transcript missing its final chunk — with no marker,
 * because the segment for it did not exist yet — and then deleted the audio it
 * was the only copy of.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_TRANSCRIPT_FOLD,
  MEETING_GAP_PHRASE,
  appendSegment,
  createCaptureSession,
  markDone,
  markTranscribing,
  type MeetingCaptureScope,
  type MeetingCaptureSession,
} from "@kinqs/brainrouter-core/meetings";
import {
  NO_CAPTURE_HOLD,
  captureInFlight,
  createCaptureHold,
  prepareSubmission,
  type MeetingCaptureHold,
} from "./composeSubmit.js";

function capture(segments: number, scope: MeetingCaptureScope = { orgId: null }): MeetingCaptureSession {
  let session = createCaptureSession({ scope, title: "Sync", startedAt: "2026-08-10T09:00:00.000Z", id: "mtg-submit" });
  for (let index = 0; index < segments; index += 1) {
    session = appendSegment(session, { byteLength: 1_000, durationMs: 20_000 });
  }
  return session;
}

/** A form with everything filled in and nothing being recorded: the case that posts. */
function ready(over: Partial<Parameters<typeof prepareSubmission>[0]> = {}): Parameters<typeof prepareSubmission>[0] {
  return {
    title: "Weekly sync",
    template: "standup",
    transcript: "Pasted notes.",
    session: null,
    fold: EMPTY_TRANSCRIPT_FOLD,
    hold: NO_CAPTURE_HOLD,
    busy: false,
    ...over,
  };
}

test("what is posted is the SETTLED transcript — every unresolved segment stated where it sits", () => {
  let session = capture(3);
  session = markDone(session, 0, "first twenty seconds");
  // Still in flight at the moment Create is pressed. The create is followed by
  // `finalizeCapture` and the deletion of the audio, so it is never coming.
  session = markTranscribing(session, 1);
  session = markDone(session, 2, "third twenty seconds");

  const prepared = prepareSubmission(ready({
    transcript: "first twenty seconds",
    session,
    fold: { inserted: new Map([[0, "first twenty seconds"]]), next: 1 },
  }));

  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  // The whole point. Without the settle this posts "first twenty seconds" — the
  // gap AND the segment after it gone, reading as contiguous speech.
  assert.equal(
    prepared.input.transcript,
    `first twenty seconds\n[00:00:20–00:00:40 ${MEETING_GAP_PHRASE}]\nthird twenty seconds`,
  );
  // What the surface warned about before the click is what actually went in.
  assert.deepEqual(prepared.stated, [1]);
  assert.equal(prepared.changed, true);
  assert.equal(prepared.fold.next, 3);
  // …and the rest of the create input is this module's too, so there is nothing
  // left for a caller to assemble differently.
  assert.equal(prepared.input.title, "Weekly sync");
  assert.equal(prepared.input.template, "standup");
});

test("a pasted transcript with no capture behind it is posted exactly as it is", () => {
  const prepared = prepareSubmission(ready({ title: "  Weekly sync  ", transcript: "Someone else's minutes." }));

  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.input.transcript, "Someone else's minutes.");
  // Trimmed here rather than at the call site: the title is posted AND used in
  // the "audio could not be released" notice, and those must be the same string.
  assert.equal(prepared.input.title, "Weekly sync");
  assert.equal(prepared.changed, false);
  // Not "nothing failed" — with no session there is no segment that could have.
  assert.deepEqual(prepared.stated, []);
});

test("a capture that is still being written to is refused — and Stop is not the end of that", () => {
  const session = markDone(capture(1), 0, "The whole meeting.");
  const posting = ready({ transcript: "The whole meeting.", session, fold: { inserted: new Map([[0, "The whole meeting."]]), next: 1 } });

  // Each of the three is separately reachable, and each was its own click.
  // `closing` is the one that cost a chunk: `stopRecording` sets `recording`
  // false on its first line and then awaits `onstop`, the final chunk's
  // `arrayBuffer`, the IPC and the disk write.
  for (const hold of [
    { ...NO_CAPTURE_HOLD, sessionId: "mtg-submit", recording: true },
    { ...NO_CAPTURE_HOLD, arming: true },
    { ...NO_CAPTURE_HOLD, sessionId: "mtg-submit", closing: true },
  ] satisfies MeetingCaptureHold[]) {
    const refused = prepareSubmission({ ...posting, hold });
    assert.equal(refused.ok, false, `a hold of ${JSON.stringify(hold)} must not post`);
    if (refused.ok) return;
    // Named as itself, because it is the one refusal a person cannot resolve by
    // filling the form in.
    assert.equal(refused.reason, "capture-in-flight");
  }

  // …and the same form, once the capture is closed, posts.
  const prepared = prepareSubmission(posting);
  assert.equal(prepared.ok, true);
  assert.equal(captureInFlight(NO_CAPTURE_HOLD), false);
  // A capture in hand is not by itself a capture in flight: an adopted recovery
  // is finished, and creating the meeting from it is what Transcribe-it is for.
  assert.equal(captureInFlight({ ...NO_CAPTURE_HOLD, sessionId: "mtg-submit" }), false);
});

test("open question 5 — the meeting is filed where the RECORDING began", () => {
  const recorded = capture(1, { orgId: "org_recorded", workspaceId: null });

  // The switcher has moved since Record; the capture's scope has not, because
  // the shared model freezes it and nothing rewrites it.
  const filed = prepareSubmission(ready({ session: recorded, activeOrgId: "org_switched_to" }));
  assert.equal(filed.ok && filed.orgId, "org_recorded");

  // A capture recorded in the personal workspace stays there — `undefined`, not
  // whatever the switcher happens to be pointing at now.
  const personal = prepareSubmission(ready({ session: capture(1), activeOrgId: "org_switched_to" }));
  assert.equal(personal.ok && personal.orgId, undefined);

  // With no capture behind the text there is no frozen scope, and the active
  // workspace is the only truth there is.
  const pasted = prepareSubmission(ready({ activeOrgId: "org_switched_to" }));
  assert.equal(pasted.ok && pasted.orgId, "org_switched_to");
});

test("the hold has one writer, and both of its copies move on every patch", () => {
  const published: MeetingCaptureHold[] = [];
  const hold = createCaptureHold((next) => published.push(next));

  hold.update({ arming: true });
  // The synchronous copy is what the submit rule reads. A click does not wait
  // for a render, and the render is the thing that lags — that lag is the whole
  // of the window a Create landed in.
  assert.equal(hold.current.arming, true);
  assert.equal(captureInFlight(hold.current), true);
  // …and the rendered copy is the SAME value, or the button and the rule are two
  // different answers to one question.
  assert.equal(published.at(-1), hold.current);

  hold.update({ sessionId: "mtg-1", recording: true, arming: false });
  assert.deepEqual(hold.current, { sessionId: "mtg-1", recording: true, arming: false, closing: false });

  // A patch leaves what it does not name alone: Stop lowers `recording` without
  // forgetting WHICH capture is being closed, and the capture stays in hand
  // afterwards so the create can release its audio.
  hold.update({ recording: false, closing: true });
  assert.equal(hold.current.sessionId, "mtg-1");
  assert.equal(captureInFlight(hold.current), true);
  hold.update({ closing: false });
  assert.equal(captureInFlight(hold.current), false);
  assert.equal(hold.current.sessionId, "mtg-1");
  assert.equal(published.length, 4);
  assert.equal(published.at(-1), hold.current);
});

test("an empty form and a busy one are refused, and are not the same refusal", () => {
  assert.deepEqual(prepareSubmission(ready({ title: "   " })), { ok: false, reason: "incomplete" });
  assert.deepEqual(prepareSubmission(ready({ transcript: "  \n " })), { ok: false, reason: "incomplete" });
  assert.deepEqual(prepareSubmission(ready({ busy: true })), { ok: false, reason: "busy" });
});
