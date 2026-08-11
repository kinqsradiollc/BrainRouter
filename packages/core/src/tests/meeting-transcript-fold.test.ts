/**
 * ADR-035 D4/D5 — the shared composition rule, and the two host answers it
 * replaces.
 *
 * D4's rule reads like a UI detail and is not one: **a user editing settled
 * text must not have their edit overwritten by a late-arriving segment**. The
 * straightforward implementation — re-render the box from the session on every
 * update — passes every manual test and destroys a correction the moment the
 * next segment lands.
 *
 * Both hosts knew that, and each defended it differently. The desktop appended
 * from a resume point and never moved what was already in the box. The
 * dashboard recomposed `base + transcriptText(session)` on every drain with
 * `base = reconcileCaptureDraft(...).retained` — the box with every segment
 * stripped out — and guarded it with a `dirty` flag that could not survive a
 * reload. Two rules for one question, and the second one reordered the meeting.
 *
 * So this file tests the append rule that moved here, and it tests it AGAINST
 * the recompose rule: `recompose` below is the dashboard's model, written out,
 * and every corruption test asserts both answers. If the recompose answers ever
 * stop being wrong, the reason this module exists has changed and the tests
 * should say so out loud rather than quietly agree.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendSegment,
  beginTranscriptFold,
  createCaptureSession,
  EMPTY_TRANSCRIPT_FOLD,
  foldTranscript,
  formatCaptureGap,
  markDone,
  markFailed,
  markTranscribing,
  MEETING_GAP_PHRASE,
  reconcileCaptureDraft,
  recoverCaptureSession,
  settleTranscriptForSubmit,
  transcriptText,
  type MeetingCaptureSession,
} from '../meetings/index.js';

const SCOPE = { orgId: 'org-1', workspaceId: null } as const;
const REOPENED_AT = '2026-08-10T09:05:00.000Z';

function capture(segments: number, id = 'mtg-fold'): MeetingCaptureSession {
  let session = createCaptureSession({ id, scope: SCOPE, title: 'Sync', startedAt: '2026-08-10T09:00:00.000Z' });
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

/** Three segments, all settled — the shape a mirrored draft comes back as. */
function threeSettled(): MeetingCaptureSession {
  let session = capture(3, 'mtg-three');
  session = markDone(session, 0, 'S1');
  session = markDone(session, 1, 'S2');
  session = markDone(session, 2, 'S3');
  return session;
}

/** What a host does with a restored box and a recovered session. */
type Compose = (box: string, session: MeetingCaptureSession) => string;

/**
 * The rule this module owns: reconcile the restored box against the session to
 * find the resume point, then APPEND from it. Nothing already in the box moves.
 */
const foldCompose: Compose = (box, session) => {
  const reconciled = reconcileCaptureDraft(box, session);
  return foldTranscript(reconciled.text, session, beginTranscriptFold(reconciled)).text;
};

/**
 * The dashboard's rule, written out: recompose the whole box as `retained` plus
 * the whole transcript. `retained` is the person's own words with every segment
 * stripped, so this necessarily puts all of their words first and the entire
 * meeting after them — whatever order they were actually in.
 */
const recompose: Compose = (box, session) => {
  const base = reconcileCaptureDraft(box, session).retained;
  const composed = transcriptText(session);
  if (!composed) return base;
  return base ? `${base}\n${composed}` : composed;
};

/** §6's destructive test: the box is restored verbatim, the session recovered. */
function killAndReopen(box: string, live: MeetingCaptureSession, compose: Compose): string {
  return compose(box, recoverCaptureSession(live, REOPENED_AT));
}

test('settled segments append in order and stop at the first one still in flight', () => {
  let session = capture(3);
  session = markDone(session, 0, 'First twenty seconds.');
  // Segment 2 settles before segment 1 does — bounded concurrency makes that
  // ordinary. It must NOT jump the queue in the transcript.
  session = markDone(session, 2, 'Third twenty seconds.');

  const first = foldTranscript('', session, EMPTY_TRANSCRIPT_FOLD);
  assert.equal(first.text, 'First twenty seconds.');
  assert.equal(first.changed, true);
  assert.equal(first.fold.next, 1, 'the walk stopped at the segment still in flight');

  session = markDone(session, 1, 'Second twenty seconds.');
  const second = foldTranscript(first.text, session, first.fold);
  assert.equal(second.text, 'First twenty seconds.\nSecond twenty seconds.\nThird twenty seconds.');

  // Nothing new: the caller can skip the state update entirely, and a second
  // fold does not append the same run again.
  const third = foldTranscript(second.text, session, second.fold);
  assert.equal(third.changed, false);
  assert.equal(third.text, second.text);
});

test('a user edit to settled text survives every later segment', () => {
  let session = capture(2);
  session = markDone(session, 0, 'Spoke to Jon about the API.');
  const first = foldTranscript('', session, EMPTY_TRANSCRIPT_FOLD);

  // The whole point of live text: the user fixes the name WHILE the meeting is
  // still running, which is the moment §1 says today's design never offers.
  const corrected = 'Spoke to John about the API.';
  session = markDone(session, 1, 'Then we sized it.');
  const second = foldTranscript(corrected, session, first.fold);

  assert.equal(second.text, 'Spoke to John about the API.\nThen we sized it.');
});

test('text the session knows nothing about is never rewritten, moved, or removed', () => {
  let session = capture(2, 'mtg-pasted');
  session = markDone(session, 0, 'Opening remarks.');
  session = markDone(session, 1, 'And the close.');
  const pasted = 'An agenda I pasted in.\nA second line of my own.';

  const folded = foldTranscript(pasted, session, EMPTY_TRANSCRIPT_FOLD);
  assert.ok(folded.text.startsWith(pasted), 'append only — their text is still the head of the box');
  assert.equal(folded.text, `${pasted}\nOpening remarks.\nAnd the close.`);
});

test('a gap waits while it is still going to be retried, and states itself once it is not', () => {
  let session = capture(2);
  session = markDone(session, 0, 'Opening remarks.');
  session = markTranscribing(session, 1);
  session = markFailed(session, 1, 'The endpoint rejected that audio.');

  // One failure is not a verdict — the shared queue will try again, so folding a
  // gap marker in now would put a lie in the box that a retry then contradicts.
  const waiting = foldTranscript('', session, EMPTY_TRANSCRIPT_FOLD);
  assert.equal(waiting.text, 'Opening remarks.');
  assert.equal(waiting.fold.next, 1);

  session = exhaust(session, 1, 'The endpoint rejected that audio.');
  const stated = foldTranscript(waiting.text, session, waiting.fold);
  assert.match(stated.text, new RegExp(MEETING_GAP_PHRASE));
  // D5 — with the time range, because that is what makes it actionable.
  assert.match(stated.text, /00:00:20–00:00:40/);
});

test('a gap that later transcribes is filled in where it sits, unless the user has touched it', () => {
  let session = exhaust(capture(2, 'mtg-heal'), 0, 'The endpoint was unreachable.');
  session = markDone(session, 1, 'And then the close.');
  const stated = foldTranscript('', session, EMPTY_TRANSCRIPT_FOLD);
  assert.equal(stated.text, `${formatCaptureGap(0, 20_000)}\nAnd then the close.`);

  // §6 — "retrying after the endpoint returns fills them in from the audio still
  // on disk". The marker this module wrote is the thing it replaces, IN PLACE:
  // appended at the end it would be out of order and the false claim would stand.
  session = markDone(markTranscribing(session, 0), 0, 'The part we thought we had lost.');
  const filled = foldTranscript(stated.text, session, stated.fold);
  assert.equal(filled.text, 'The part we thought we had lost.\nAnd then the close.');
  assert.equal(filled.changed, true);
  assert.equal(filled.fold.inserted.get(0), 'The part we thought we had lost.', 'the box and the fold agree on what is in it');
  assert.ok(!filled.text.includes(MEETING_GAP_PHRASE), 'the claim that it could not be transcribed is gone');

  // …but a box the user has rewritten is theirs. Invariant 1 outranks the
  // correction: nothing is replaced, and the recovered text is not appended out
  // of order either.
  const owned = foldTranscript('I typed this bit in from memory.\nAnd then the close.', session, stated.fold);
  assert.equal(owned.text, 'I typed this bit in from memory.\nAnd then the close.');
  assert.equal(owned.changed, false);
});

test('a marker the person DELETED is not resurrected by the retry that fills it', () => {
  let session = exhaust(capture(2, 'mtg-deleted'), 0, 'The endpoint was unreachable.');
  session = markDone(session, 1, 'And then the close.');
  const stated = foldTranscript('', session, EMPTY_TRANSCRIPT_FOLD);

  // They deleted the marker line: they do not want a hole advertised in a
  // transcript they are about to send to five people.
  const trimmed = 'And then the close.';
  session = markDone(markTranscribing(session, 0), 0, 'The part we thought we had lost.');
  const after = foldTranscript(trimmed, session, stated.fold);

  assert.equal(after.text, trimmed, 'their deletion is a decision, and it holds');
  assert.equal(after.changed, false);
});

test('healing a gap is a literal replacement — a transcript containing $& stays itself', () => {
  const session = exhaust(capture(1, 'mtg-dollar'), 0, 'The endpoint was unreachable.');
  const stated = foldTranscript('', session, EMPTY_TRANSCRIPT_FOLD);

  // A meeting about shell scripting says this out loud. `String.replace` reads
  // `$&` out of the REPLACEMENT, so a naive heal writes the gap marker back into
  // the box in place of the words that were just recovered.
  const recovered = 'Then use $& to repeat the match.';
  const filled = foldTranscript(
    stated.text,
    markDone(markTranscribing(session, 0), 0, recovered),
    stated.fold,
  );
  assert.equal(filled.text, recovered);
  assert.ok(!filled.text.includes(MEETING_GAP_PHRASE));
});

test('a settled segment with no text contributes nothing and does not stop the walk', () => {
  let session = capture(3, 'mtg-silent');
  session = markDone(session, 0, 'Before the pause.');
  // Twenty genuinely silent seconds. It is settled, not missing, so it is not a
  // gap and it must not hold the rest of the meeting behind it.
  session = markDone(session, 1, '');
  session = markDone(session, 2, 'After the pause.');

  const folded = foldTranscript('', session, EMPTY_TRANSCRIPT_FOLD);
  assert.equal(folded.text, 'Before the pause.\nAfter the pause.');
  assert.equal(folded.fold.next, 3, 'the silence did not stop the walk');
  assert.equal(folded.fold.inserted.has(1), false, 'nothing was put in the box for it');
});

test('multi-line segment text folds as one contribution', () => {
  let session = capture(2, 'mtg-multi');
  session = markDone(session, 0, 'First line.\nStill segment zero.');
  session = markDone(session, 1, 'Segment one.');

  const folded = foldTranscript('', session, EMPTY_TRANSCRIPT_FOLD);
  assert.equal(folded.text, 'First line.\nStill segment zero.\nSegment one.');
  assert.equal(folded.fold.inserted.get(0), 'First line.\nStill segment zero.');
});

test('the shared empty fold is not mutated by using it', () => {
  const session = threeSettled();
  const folded = foldTranscript('', session, EMPTY_TRANSCRIPT_FOLD);
  assert.equal(folded.fold.inserted.size, 3);
  // A capture that shared the constant's map with the previous one would resume
  // a NEW recording partway through the last one's transcript.
  assert.equal(EMPTY_TRANSCRIPT_FOLD.inserted.size, 0);
  assert.equal(EMPTY_TRANSCRIPT_FOLD.next, 0);
});

test('§6 — kill, reopen, restore the box: the meeting comes back once, in order', () => {
  // The live session at the instant of the kill: two settled, one mid-attempt.
  let live = capture(3, 'mtg-kill');
  live = markDone(live, 0, 'S1');
  live = markDone(live, 1, 'S2');
  live = markTranscribing(live, 2, '2026-08-10T09:01:00.000Z');
  const box = 'Agenda I pasted in.\nS1\nS2';

  const filed = killAndReopen(box, live, foldCompose);

  assert.ok(filed.startsWith(box), 'nothing already in the box moved');
  assert.equal(filed.split('S1').length - 1, 1, 'each segment appears exactly once');
  assert.equal(filed.split('S2').length - 1, 1);
  // The interrupted segment is `recoverCaptureSession`'s failure with an attempt
  // already spent, so it is still retryable and is not stated as a gap yet.
  assert.equal(filed, box);
});

test('§6 + D5 — a gap restored from the draft is still OURS, and heals in place after the kill', () => {
  let live = exhaust(capture(2, 'mtg-kill-gap'), 0, 'The endpoint did not answer.');
  live = markDone(live, 1, 'And then the close.');
  const marker = formatCaptureGap(0, 20_000);
  const box = `${marker}\nAnd then the close.`;

  // Reopened: the box is restored verbatim and reconciled, and the resume point
  // carries the exact strings the box holds for each segment — not just how far
  // the fold got. Without them the marker in the box is a line this rule no
  // longer recognises as its own, and the retry below can never correct it.
  const recovered = recoverCaptureSession(live, REOPENED_AT);
  const reconciled = reconcileCaptureDraft(box, recovered);
  const resumed = foldTranscript(reconciled.text, recovered, beginTranscriptFold(reconciled));
  assert.equal(resumed.text, box, 'nothing appended, nothing moved');

  // D5's retry affordance, after a restart, from the audio still on disk.
  const repaired = markDone(markTranscribing(recovered, 0), 0, 'The recovered words.');
  const healed = foldTranscript(resumed.text, repaired, resumed.fold);
  assert.equal(healed.text, 'The recovered words.\nAnd then the close.');
});

test('the doubling this replaces — resuming the fold at zero files the meeting twice', () => {
  // Not a test of the rule but of the thing `beginTranscriptFold` exists to
  // stop. If this ever stops doubling, the test above has stopped proving it.
  const session = threeSettled();
  const box = 'S1\nS2\nS3';
  assert.equal(foldTranscript(box, session, EMPTY_TRANSCRIPT_FOLD).text, `${box}\n${box}`);
});

test('corruption — a note typed BETWEEN two segments stays where the person put it', () => {
  const session = threeSettled();
  const box = 'S1\nMy note\nS2\nS3';

  assert.equal(killAndReopen(box, session, foldCompose), box, 'the note is still a remark inside the meeting');

  // The reproduced dashboard defect: `retained` is the note alone, so
  // recomposing puts it above the entire transcript. Nothing warns, and the
  // person's own record now reads as a preamble they wrote before recording.
  assert.equal(
    killAndReopen(box, session, recompose),
    'My note\nS1\nS2\nS3',
    'recomposing relocates it to the top',
  );
});

test('corruption — an edit to the LAST settled segment is not reverted and not moved', () => {
  const session = threeSettled();
  const box = 'S1\nS2\nS3 corrected';

  // The honest limit of the append rule, and the safe direction of the two: an
  // edit to the last settled segment leaves no anchor after it, so that segment
  // reads as never-folded and is appended once more. Their edit is still theirs,
  // still where they put it, beside one duplicate line they can delete.
  assert.equal(killAndReopen(box, session, foldCompose), 'S1\nS2\nS3 corrected\nS3');

  // The reproduced dashboard defect, which is the unsafe direction of the same
  // ambiguity: the pre-edit wording is restored INTO the meeting and the edit is
  // relocated above it.
  assert.equal(
    killAndReopen(box, session, recompose),
    'S3 corrected\nS1\nS2\nS3',
    'recomposing both reverts and relocates',
  );
});

test('corruption — a settled segment the person DELETED stays deleted across a kill', () => {
  const session = threeSettled();
  const box = 'S1\nS3';

  assert.equal(killAndReopen(box, session, foldCompose), box, 'a deletion is a decision, and it holds');
  assert.equal(killAndReopen(box, session, recompose), 'S1\nS2\nS3', 'recomposing brings the deleted line back');
});

test('submitting states every unresolved segment as a gap rather than dropping it', () => {
  let session = capture(3, 'mtg-submit');
  session = markDone(session, 0, 'We agreed on the schema.');
  session = markTranscribing(session, 1);
  // Segment 2 has failed once and would ordinarily still be retried; the meeting
  // is being created now, so it never will be.
  session = markFailed(markTranscribing(session, 2), 2, 'The endpoint rejected that audio.');

  const fold = { inserted: new Map([[0, 'We agreed on the schema.']]), next: 1 };
  const submitted = settleTranscriptForSubmit('We agreed on the schema.', session, fold);

  assert.equal(
    submitted.text,
    `We agreed on the schema.\n${formatCaptureGap(20_000, 40_000)}\n${formatCaptureGap(40_000, 60_000)}`,
  );
  // What the surface warned about before the click is what actually went in:
  // only the segment still in flight was unsettled — the failed one was already
  // a stated gap.
  assert.deepEqual(submitted.stated, [1]);
  assert.equal(submitted.changed, true);
  assert.equal(submitted.fold.next, 3);
});

test('submitting a pasted transcript with no capture behind it changes nothing', () => {
  const pasted = 'Notes a colleague sent me.';
  const submitted = settleTranscriptForSubmit(pasted, null, EMPTY_TRANSCRIPT_FOLD);
  assert.equal(submitted.text, pasted);
  assert.equal(submitted.changed, false);
  // Not the same claim as "nothing failed": with no session there is no segment
  // that could have.
  assert.deepEqual(submitted.stated, []);
});

test("submitting keeps the person's edits and their order, gaps included", () => {
  let session = capture(2, 'mtg-submit-edited');
  session = markDone(session, 0, 'Spoke to Jon about the API.');
  session = markTranscribing(session, 1);
  const folded = foldTranscript('', session, EMPTY_TRANSCRIPT_FOLD);

  const edited = 'Spoke to John about the API.\nMy own follow-up note.';
  const submitted = settleTranscriptForSubmit(edited, session, folded.fold);

  assert.ok(submitted.text.startsWith(edited), 'the box they are looking at is the head of what is POSTed');
  assert.equal(submitted.text, `${edited}\n${formatCaptureGap(20_000, 40_000)}`);
});
