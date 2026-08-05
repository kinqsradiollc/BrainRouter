/**
 * ADR-028 F2/F3/F4 — explain, decisions, verification.
 *
 * The properties worth pinning are the refusals: an explanation is not
 * volunteered on a schedule, a decision log that records no rejected
 * alternative records nothing, and a verification hand-off that claims
 * everything was checked is almost always lying in a way that reads like
 * thoroughness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mayOfferExplanation, DEPTH_INTENT,
  isWorthRecording, isReconstructed,
  validateHandoff, describeHandoff, METHOD_PHRASE,
  type VerificationHandoff,
} from '../comprehension/workRecord.js';

/* --------------------------------------------------------------- F2 */

test('an explanation is offered ONCE, and only for large work', () => {
  // An agent that explains itself after every turn trains the reflex that
  // makes the important explanation get skipped.
  assert.equal(mayOfferExplanation({ changedFiles: 20, alreadyOffered: false }), true);
  assert.equal(mayOfferExplanation({ changedFiles: 20, alreadyOffered: true }), false);
  assert.equal(mayOfferExplanation({ changedFiles: 2, alreadyOffered: false }), false);
});

test('each depth states what it is FOR, so the choice is informed', () => {
  assert.match(DEPTH_INTENT.why, /road not taken/);
  assert.match(DEPTH_INTENT.teach, /maintain this alone/);
});

/* --------------------------------------------------------------- F3 */

test('a decision with no rejected alternative is not a decision', () => {
  // "We did X" is recoverable from the diff. The value is entirely in what was
  // considered and dropped.
  assert.equal(isWorthRecording({ rejected: 'none', because: 'it was the only way' }), false);
  assert.equal(isWorthRecording({ rejected: '', because: 'because' }), false);
  assert.equal(
    isWorthRecording({ rejected: 'a CRDT merge', because: 'it produces a document neither person wrote' }),
    true,
  );
});

test('a decision recorded AFTER the work is a reconstruction', () => {
  // A log written at the end rationalises what happened rather than recording
  // what was decided — the alternatives genuinely considered are exactly the
  // ones you forget by then.
  const entry = {
    id: 'd1', chose: 'HLC', rejected: 'wall clock', because: 'devices lie',
    at: '2026-08-04T18:00:00.000Z',
  };
  assert.equal(isReconstructed(entry, '2026-08-04T17:00:00.000Z'), true);
  assert.equal(isReconstructed({ ...entry, at: '2026-08-04T15:00:00.000Z' }, '2026-08-04T17:00:00.000Z'), false);
});

/* --------------------------------------------------------------- F4 */

test('a verified claim with no evidence is refused', () => {
  // That is the exact substitution B1 refuses for receipts, applied to work.
  const handoff: VerificationHandoff = {
    verified: [{ claim: 'the merge is correct', method: 'test', evidence: '' }],
    unverified: [], lookAt: null,
  };
  assert.match(validateHandoff(handoff)!, /names no evidence/);
});

test('claiming everything was verified is challenged', () => {
  // The failure is invisible: it reads like thoroughness.
  const handoff: VerificationHandoff = {
    verified: [{ claim: 'it compiles', method: 'typecheck', evidence: 'tsc --noEmit' }],
    unverified: [], lookAt: null,
  };
  assert.match(validateHandoff(handoff)!, /rarely true/);
});

test('an honest hand-off passes', () => {
  const handoff: VerificationHandoff = {
    verified: [{ claim: 'the cascade lands every layer', method: 'test', evidence: 'stack-lifecycle.test.ts' }],
    unverified: [{ claim: 'the merge works against real GitHub', why: 'no repository with gh-stack to test against' }],
    lookAt: 'whether `gh stack merge` accepts the argv we build',
  };
  assert.equal(validateHandoff(handoff), null);
});

test('the summary leads with what was NOT checked', () => {
  // Leading with the verified count reads as reassurance, and reassurance is
  // what this artifact exists to withhold.
  const text = describeHandoff({
    verified: [{ claim: 'a', method: 'test', evidence: 'x' }],
    unverified: [{ claim: 'b', why: 'no environment' }],
    lookAt: 'the argv',
  });
  assert.match(text, /^1 thing I could not check/);
  assert.match(text, /Start with: the argv/);
});

test('"I read it" makes no stronger claim than that', () => {
  // The phrase that stops a skim being reported as verification.
  assert.match(METHOD_PHRASE.read_it, /no stronger claim/);
  assert.doesNotMatch(METHOD_PHRASE.typecheck, /works|correct/);
});
