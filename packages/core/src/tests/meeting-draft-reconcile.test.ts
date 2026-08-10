/**
 * ADR-035 D4 — the recovered meeting is filed once, not twice.
 *
 * The defect these tests exist for: both hosts mirror the live transcript into
 * the compose draft, both persist that draft, and both then folded a recovered
 * session in from segment zero on top of it. A box holding
 * "Sentence 1.\nSentence 2.\nSentence 3." became that text twice, and the
 * doubled version was what got POSTed and summarized.
 *
 * So the load-bearing assertions here are a pair, and neither is sufficient
 * alone: folding a mirrored draft must not duplicate anything, and reconciling
 * must not delete a word the person wrote.
 *
 * `fold` below stands in for the hosts' append step (the desktop's
 * `foldTranscript`, the dashboard's compose) so the round trip — reconcile, then
 * append what is left — can be asserted end to end from core.
 *
 * ## What this file got wrong last round, and how it is written now
 *
 * The §6 test handed `reconcileCaptureDraft` a restored draft that still held
 * the transcript — correct under the contract, but a shape the product could not
 * produce, because both hosts were persisting `retained` (the box with every
 * segment stripped out) and replaying THAT. So the test asserted the happy path
 * of an input the product never had, and four corruptions of the input it did
 * have went unnoticed.
 *
 * The fix is structural rather than another case: every kill-and-reopen test
 * goes through `killAndReopen`, which takes the PERSIST STEP as a parameter.
 * `persistWholeBox` is the contract; `persistRetained` is what the hosts did.
 * The four corruptions are the difference between them, asserted as text, so
 * neither the contract nor the reason for it can quietly stop being true.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendSegment,
  createCaptureSession,
  formatCaptureGap,
  markDone,
  markFailed,
  markTranscribing,
  MEETING_GAP_PHRASE,
  reconcileCaptureDraft,
  recoverCaptureSession,
  transcriptSoFar,
  type MeetingCaptureSession,
} from '../meetings/index.js';

const SCOPE = { orgId: 'org-1', workspaceId: null } as const;

/** `count` twenty-second segments, all still pending. */
function capture(count: number, id = 'mtg-draft'): MeetingCaptureSession {
  let session = createCaptureSession({
    id,
    scope: SCOPE,
    title: 'Weekly sync',
    startedAt: '2026-08-09T10:00:00.000Z',
  });
  for (let index = 0; index < count; index += 1) {
    session = appendSegment(session, { byteLength: 4096, durationMs: 20_000 });
  }
  return session;
}

function settle(session: MeetingCaptureSession, index: number, text: string): MeetingCaptureSession {
  return markDone(markTranscribing(session, index, stampFor(index)), index, text);
}

function black(session: MeetingCaptureSession, index: number): MeetingCaptureSession {
  return markFailed(markTranscribing(session, index, stampFor(index)), index, 'The endpoint did not answer.');
}

function stampFor(index: number): string {
  return `2026-08-09T10:00:${String(20 + index * 20).padStart(2, '0')}.000Z`;
}

/** The mirrored-draft case: three segments, all settled. */
function threeSettled(): MeetingCaptureSession {
  let session = capture(3);
  session = settle(session, 0, 'Sentence 1.');
  session = settle(session, 1, 'Sentence 2.');
  session = settle(session, 2, 'Sentence 3.');
  return session;
}

/**
 * The hosts' append step: everything from `next` onward that will not change on
 * its own, joined the way both hosts join it.
 */
function fold(text: string, session: MeetingCaptureSession, next: number): string {
  const additions = transcriptSoFar(session)
    .slice(next)
    .filter((entry) => entry.kind !== 'provisional' && entry.text.length > 0)
    .map((entry) => entry.text);
  if (!additions.length) return text;
  const joined = additions.join('\n');
  return text ? `${text}\n${joined}` : joined;
}

/** What a host writes to its draft store. The contract, and the violation. */
type PersistDraft = (box: string, session: MeetingCaptureSession) => string;

/**
 * The contract: the whole compose box, exactly as the person sees it. Both hosts
 * now keep the draft in protected storage, so there is no size objection left to
 * stripping it — and stripping it is what the four tests below cost.
 */
const persistWholeBox: PersistDraft = (box) => box;

/**
 * What both hosts persisted instead: `retained`, the box with every segment
 * contribution removed. Replaying it feeds the frontier rule the COMPLEMENT of
 * its own input.
 */
const persistRetained: PersistDraft = (box, session) => reconcileCaptureDraft(box, session).retained;

/**
 * §6's destructive test, as the hosts perform it: whatever was persisted is
 * restored verbatim into the next compose box, reconciled against the recovered
 * session, and the rest of the transcript folded in. The answer is the text the
 * person is left looking at — and the text that gets POSTed and summarized.
 */
function killAndReopen(box: string, live: MeetingCaptureSession, persist: PersistDraft): string {
  const restored = persist(box, live);
  const recovered = recoverCaptureSession(live, '2026-08-09T10:05:00.000Z');
  const reconciled = reconcileCaptureDraft(restored, recovered);
  return fold(reconciled.text, recovered, reconciled.next);
}

test('the fatal case — a draft that IS the mirrored transcript folds in once, not twice', () => {
  const session = threeSettled();
  const draft = 'Sentence 1.\nSentence 2.\nSentence 3.';

  const reconciled = reconcileCaptureDraft(draft, session);

  assert.equal(reconciled.text, draft, 'reconciliation rewrites nothing here');
  assert.deepEqual(reconciled.accounted, [0, 1, 2]);
  assert.equal(reconciled.next, 3, 'there is nothing left to fold in');
  assert.deepEqual(reconciled.userOwned, []);
  assert.equal(reconciled.retained, '', 'every line is the session speaking');

  const filed = fold(reconciled.text, session, reconciled.next);
  assert.equal(filed, draft);
  assert.equal(filed.split('Sentence 2.').length - 1, 1, 'each sentence appears exactly once');
});

test('the defect it replaces — folding from segment zero over the same draft doubles the meeting', () => {
  // Not a test of this module, but of the thing it exists to stop: with the old
  // `next = 0`, the very same fold step produces the meeting twice. If this ever
  // stops doubling, the test above has stopped proving anything.
  const session = threeSettled();
  const draft = 'Sentence 1.\nSentence 2.\nSentence 3.';
  assert.equal(fold(draft, session, 0), `${draft}\n${draft}`);
});

test('pasted text the session knows nothing about survives, and the transcript still arrives', () => {
  const session = threeSettled();
  const draft = 'Notes I pasted before recording.\nAnd a second line of my own.';

  const reconciled = reconcileCaptureDraft(draft, session);

  assert.equal(reconciled.text, draft, 'not one character of theirs is touched');
  assert.deepEqual(reconciled.accounted, [], 'no segment can account for any of it');
  assert.equal(reconciled.next, 0);
  assert.equal(reconciled.retained, draft, 'all of it is theirs');

  const filed = fold(reconciled.text, session, reconciled.next);
  assert.equal(filed, `${draft}\nSentence 1.\nSentence 2.\nSentence 3.`);
});

test('a mirrored draft the person has added to keeps the addition and still folds once', () => {
  const session = threeSettled();
  const draft = 'A heading of my own\nSentence 1.\nSentence 2.\nSentence 3.\nMy closing note.';

  const reconciled = reconcileCaptureDraft(draft, session);

  assert.deepEqual(reconciled.accounted, [0, 1, 2]);
  assert.equal(reconciled.next, 3);
  assert.equal(reconciled.retained, 'A heading of my own\nMy closing note.');
  assert.equal(fold(reconciled.text, session, reconciled.next), draft, 'nothing is appended, nothing is lost');
});

test('D4 — an edit to a settled segment wins, and is never restored or re-appended', () => {
  const session = threeSettled();
  // The person fixed a name in segment 1 after it settled.
  const draft = 'Sentence 1.\nSentence 2, corrected by hand.\nSentence 3.';

  const reconciled = reconcileCaptureDraft(draft, session);

  assert.equal(reconciled.text, draft, 'their wording stands');
  assert.deepEqual(reconciled.accounted, [0, 1, 2], 'the draft has plainly moved past segment 1');
  assert.deepEqual(reconciled.userOwned, [1], 'and segment 1 belongs to them now');
  assert.equal(reconciled.matched.get(1), undefined, 'nothing may rewrite what is no longer ours');
  assert.equal(reconciled.next, 3);

  const filed = fold(reconciled.text, session, reconciled.next);
  assert.equal(filed, draft);
  assert.ok(!filed.includes('Sentence 2.\n'), 'the original wording does not come back');
});

test('D4 — a settled segment the person DELETED stays deleted', () => {
  const session = threeSettled();
  const draft = 'Sentence 1.\nSentence 3.';

  const reconciled = reconcileCaptureDraft(draft, session);

  assert.deepEqual(reconciled.accounted, [0, 1, 2]);
  assert.deepEqual(reconciled.userOwned, [1]);
  assert.equal(fold(reconciled.text, session, reconciled.next), draft);
});

test('an empty draft folds the whole transcript in, exactly once', () => {
  const session = threeSettled();
  const reconciled = reconcileCaptureDraft('', session);

  assert.equal(reconciled.text, '');
  assert.deepEqual(reconciled.accounted, []);
  assert.equal(reconciled.next, 0);
  assert.equal(reconciled.retained, '');
  assert.equal(reconciled.matched.size, 0);
  assert.equal(fold(reconciled.text, session, reconciled.next), 'Sentence 1.\nSentence 2.\nSentence 3.');
});

test('a session with no segments leaves the draft exactly as it was', () => {
  const session = createCaptureSession({ id: 'mtg-none', scope: SCOPE, startedAt: '2026-08-09T10:00:00.000Z' });
  const reconciled = reconcileCaptureDraft('Only my words.', session);
  assert.equal(reconciled.text, 'Only my words.');
  assert.equal(reconciled.retained, 'Only my words.');
  assert.equal(reconciled.next, 0);
});

test('D5 — a gap the draft states is accounted for, and healed in place once it transcribes', () => {
  let session = capture(3);
  session = settle(session, 0, 'Sentence 1.');
  session = black(session, 1);
  session = settle(session, 2, 'Sentence 3.');
  const marker = formatCaptureGap(20_000, 40_000);
  const draft = `Sentence 1.\n${marker}\nSentence 3.`;

  // While it is still a gap: stated, accounted for, nothing appended.
  const stated = reconcileCaptureDraft(draft, session);
  assert.deepEqual(stated.accounted, [0, 1, 2]);
  assert.equal(stated.matched.get(1), marker);
  assert.equal(fold(stated.text, session, stated.next), draft);

  // The retry filled it in from the audio still on disk (§6).
  const repaired = markDone(markTranscribing(session, 1, stampFor(3)), 1, 'The missing twenty seconds.');
  const healed = reconcileCaptureDraft(draft, repaired);
  assert.equal(healed.text, 'Sentence 1.\nThe missing twenty seconds.\nSentence 3.');
  assert.equal(healed.matched.get(1), 'The missing twenty seconds.');
  assert.equal(healed.next, 3, 'healing in place is not a reason to append it as well');
  assert.equal(fold(healed.text, repaired, healed.next), healed.text);
});

test('a gap marker the person overwrote is theirs, and is not healed back', () => {
  let session = capture(3);
  session = settle(session, 0, 'Sentence 1.');
  session = black(session, 1);
  session = settle(session, 2, 'Sentence 3.');
  const draft = 'Sentence 1.\nI typed this bit in from memory.\nSentence 3.';
  const repaired = markDone(markTranscribing(session, 1, stampFor(3)), 1, 'The missing twenty seconds.');

  const reconciled = reconcileCaptureDraft(draft, repaired);
  assert.equal(reconciled.text, draft);
  assert.deepEqual(reconciled.userOwned, [1]);
  assert.equal(fold(reconciled.text, repaired, reconciled.next), draft);
});

test('segments still in flight are not accounted for by anything, and arrive when they settle', () => {
  let session = capture(4);
  session = settle(session, 0, 'Sentence 1.');
  session = settle(session, 1, 'Sentence 2.');
  session = settle(session, 2, 'Sentence 3.');
  const draft = 'Sentence 1.\nSentence 2.\nSentence 3.';

  const reconciled = reconcileCaptureDraft(draft, session);
  assert.equal(reconciled.next, 3, 'the pending segment has contributed nothing yet');
  assert.equal(fold(reconciled.text, session, reconciled.next), draft);

  const settled = settle(session, 3, 'Sentence 4.');
  assert.equal(fold(reconciled.text, settled, reconciled.next), `${draft}\nSentence 4.`);
});

test('repeated sentences are matched positionally, not by first occurrence', () => {
  let session = capture(3, 'mtg-echo');
  session = settle(session, 0, 'Okay.');
  session = settle(session, 1, 'Okay.');
  session = settle(session, 2, 'Right, moving on.');
  const draft = 'Okay.\nOkay.\nRight, moving on.';

  const reconciled = reconcileCaptureDraft(draft, session);
  assert.deepEqual(reconciled.accounted, [0, 1, 2]);
  assert.equal(fold(reconciled.text, session, reconciled.next), draft, 'no echo is folded in twice');
});

test('a segment whose text appears inside a typed sentence is not mistaken for a fold', () => {
  let session = capture(1, 'mtg-short');
  session = settle(session, 0, 'Yes.');
  const draft = 'I asked whether we ship on Friday and the answer was Yes. Then we moved on.';

  const reconciled = reconcileCaptureDraft(draft, session);
  assert.equal(reconciled.next, 0, 'a substring inside their prose is not our line');
  assert.equal(fold(reconciled.text, session, reconciled.next), `${draft}\nYes.`);
});

test('multi-line segment text folds and reconciles as one contribution', () => {
  let session = capture(2, 'mtg-multi');
  session = settle(session, 0, 'First line.\nStill segment zero.');
  session = settle(session, 1, 'Segment one.');
  const draft = 'First line.\nStill segment zero.\nSegment one.';

  const reconciled = reconcileCaptureDraft(draft, session);
  assert.deepEqual(reconciled.accounted, [0, 1]);
  assert.equal(reconciled.retained, '');
  assert.equal(fold(reconciled.text, session, reconciled.next), draft);
});

test('§6 end to end — kill, reopen, restore the draft, adopt the recovery: one meeting', () => {
  // The live session at the instant of the kill: two settled, one mid-attempt.
  let live = capture(3);
  live = settle(live, 0, 'Sentence 1.');
  live = settle(live, 1, 'Sentence 2.');
  live = markTranscribing(live, 2, '2026-08-09T10:01:00.000Z');
  // The box at that instant: their agenda, and the transcript the surface has
  // mirrored into it. This — not some stripped version of it — is what the
  // draft store holds when the process dies.
  const box = 'Agenda I pasted in.\nSentence 1.\nSentence 2.';
  assert.equal(persistWholeBox(box, live), box, 'the draft store holds the meeting, not a residue of it');

  const filed = killAndReopen(box, live, persistWholeBox);

  assert.ok(filed.startsWith('Agenda I pasted in.'), 'their agenda is still the first thing in the box');
  assert.equal(filed.split('Sentence 1.').length - 1, 1);
  assert.equal(filed.split('Sentence 2.').length - 1, 1);
  // The interrupted segment is stated rather than left spinning, and stated once.
  assert.equal(filed, `${box}\n${formatCaptureGap(40_000, 60_000)}`, 'the interrupted range is stated, once');

  // And the reason the four tests below exist: on THIS input — nothing edited,
  // nothing deleted — persisting `retained` instead reaches the same answer. A
  // §6 test alone cannot see the contract being violated, which is exactly how
  // it was violated on both hosts for a round.
  assert.equal(killAndReopen(box, live, persistRetained), filed, 'indistinguishable here, and only here');
});

/**
 * The four corruptions of replaying `retained`.
 *
 * Each is the same shape: the same box and the same session, persisted the two
 * ways. Under the contract the meeting survives the kill intact; under the strip
 * it comes back wrong, silently, in a way no error and no marker announces.
 */
test('corruption 1 — one whole-line collision drops every earlier segment, with no gap marker', () => {
  let session = capture(3, 'mtg-collide');
  session = settle(session, 0, 'Sentence 1.');
  session = settle(session, 1, 'Sentence 2.');
  // The meeting ends by saying out loud the action item the person had already
  // typed at the top of the box. One line, identical.
  session = settle(session, 2, 'Ship on Friday.');
  const box = 'Ship on Friday.\nSentence 1.\nSentence 2.\nShip on Friday.';

  assert.equal(killAndReopen(box, session, persistWholeBox), box, 'the whole meeting survives the kill');

  // Stripped, the box is just their note — which the walk then matches against
  // segment 2, pinning the frontier there. Segments 0 and 1 are reported
  // accounted-for and user-owned, so nothing folds them in.
  const stripped = persistRetained(box, session);
  assert.equal(stripped, 'Ship on Friday.');
  const reconciled = reconcileCaptureDraft(stripped, session);
  assert.deepEqual(reconciled.userOwned, [0, 1], 'text the person never touched, declared theirs');

  const corrupted = killAndReopen(box, session, persistRetained);
  assert.equal(corrupted, 'Ship on Friday.', 'two minutes of meeting are simply gone');
  assert.ok(!corrupted.includes('Sentence 1.'));
  assert.ok(!corrupted.includes('Sentence 2.'));
  // The part that makes it a silent loss rather than a stated one (D5).
  assert.ok(!corrupted.includes(MEETING_GAP_PHRASE), 'and nothing in the box says anything is missing');
});

test('corruption 2 — an edited segment doubles across the kill', () => {
  const session = threeSettled();
  // D4: the person fixed a name after segment 1 settled.
  const box = 'Sentence 1.\nSentence 2, corrected by hand.\nSentence 3.';

  assert.equal(killAndReopen(box, session, persistWholeBox), box, 'their wording stands, and stands alone');

  // The edit is the only thing the strip keeps — and with the segments gone,
  // nothing records that it WAS segment 1, so segment 1 folds in beside it.
  assert.equal(persistRetained(box, session), 'Sentence 2, corrected by hand.');
  assert.equal(
    killAndReopen(box, session, persistRetained),
    'Sentence 2, corrected by hand.\nSentence 1.\nSentence 2.\nSentence 3.',
    'the pre-edit wording is back, the meeting is out of order, and the edit is now a duplicate',
  );
});

test('corruption 3 — a deleted line comes back', () => {
  const session = threeSettled();
  const box = 'Sentence 1.\nSentence 3.';

  assert.equal(killAndReopen(box, session, persistWholeBox), box, 'a deletion is a decision, and it holds');

  // A deletion leaves nothing behind, so the stripped box is empty and the
  // reopened one has no evidence any of this was ever in it.
  assert.equal(persistRetained(box, session), '');
  const corrupted = killAndReopen(box, session, persistRetained);
  assert.equal(corrupted, 'Sentence 1.\nSentence 2.\nSentence 3.');
  assert.ok(corrupted.includes('Sentence 2.'), 'the line they deleted is back in the meeting');
});

test('corruption 4 — a note typed between two segments is relocated to the top', () => {
  const session = threeSettled();
  const box = 'Sentence 1.\nMy note about that first bit.\nSentence 2.\nSentence 3.';

  assert.equal(killAndReopen(box, session, persistWholeBox), box, 'their note stays where they put it');

  assert.equal(persistRetained(box, session), 'My note about that first bit.');
  assert.equal(
    killAndReopen(box, session, persistRetained),
    'My note about that first bit.\nSentence 1.\nSentence 2.\nSentence 3.',
    'the note now reads as a preamble to a meeting it was a remark inside',
  );
});
