/**
 * ADR-028 F1/F5/F6 — comprehension is profile-shaped.
 *
 * The properties worth pinning are the guards: the tutor never obstructs a
 * blocked professional, and a research claim that nobody could disprove is
 * refused as a position rather than accepted as a finding.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  modeForProfile, MODE_SHAPE, shouldAskFirst, detectUrgency, hintLadder,
  validateResearchClaim, describeResearchClaim, orderForMode,
  type ResearchClaim,
} from '../comprehension/profileComprehension.js';

/* ------------------------------------------------------------- F1 · modes */

test('research and study profiles get their own modes; the rest get engineer', () => {
  // Not because everyone writes code — because "unable to change this later"
  // is the default risk of accepting work you did not produce.
  assert.equal(modeForProfile('research'), 'researcher');
  assert.equal(modeForProfile('data-science'), 'researcher');
  assert.equal(modeForProfile('study'), 'learner');
  assert.equal(modeForProfile('education'), 'learner');
  assert.equal(modeForProfile('engineering'), 'engineer');
  assert.equal(modeForProfile('marketing'), 'engineer');
  assert.equal(modeForProfile(undefined), 'engineer');
});

test('each mode names what the person must not lose', () => {
  assert.match(MODE_SHAPE.engineer.stake, /change this later/);
  assert.match(MODE_SHAPE.researcher.stake, /how much to believe/);
  assert.match(MODE_SHAPE.learner.stake, /the skill itself/);
});

test('a researcher is asked WHY first — it determines what the result is worth', () => {
  assert.equal(MODE_SHAPE.researcher.focusOrder[0], 'rationale');
  assert.equal(MODE_SHAPE.engineer.focusOrder[0], 'consequence');
});

test('questions are reordered for the mode, not rewritten', () => {
  const qs = [{ focus: 'reversibility' as const }, { focus: 'rationale' as const }];
  assert.deepEqual(orderForMode(qs, 'researcher').map((q) => q.focus), ['rationale', 'reversibility']);
  assert.deepEqual(orderForMode(qs, 'engineer').map((q) => q.focus), ['reversibility', 'rationale']);
});

/* ------------------------------------------------------------- F5 · tutor */

test('the tutor NEVER obstructs a blocked professional', () => {
  // Socratic method aimed at someone debugging production at 2am is
  // obstruction wearing a teacher's costume.
  assert.equal(shouldAskFirst({
    mode: 'learner', instructional: true, urgencySignals: true, alreadyAsked: false,
  }), false);
});

test('"just tell me" is honoured, and never questioned', () => {
  for (const text of ['just tell me', 'prod is down', 'this is urgent', 'I am stuck']) {
    assert.equal(detectUrgency(text), true, `${text} must read as urgency`);
  }
  assert.equal(detectUrgency('how does the merge work?'), false);
});

test('asking twice is stalling', () => {
  assert.equal(shouldAskFirst({
    mode: 'learner', instructional: true, urgencySignals: false, alreadyAsked: true,
  }), false);
});

test('only learner mode asks first — the profile is opt-in', () => {
  for (const mode of ['engineer', 'researcher'] as const) {
    assert.equal(shouldAskFirst({
      mode, instructional: true, urgencySignals: false, alreadyAsked: false,
    }), false);
  }
  assert.equal(shouldAskFirst({
    mode: 'learner', instructional: true, urgencySignals: false, alreadyAsked: false,
  }), true);
});

test('the hint ladder ends at the answer — it does not withhold forever', () => {
  const ladder = hintLadder();
  assert.equal(ladder.at(-1), 'give the fix');
  assert.ok(ladder.length >= 3);
});

/* ---------------------------------------------------------- F6 · research */

const claim = (over: Partial<ResearchClaim> = {}): ResearchClaim => ({
  claim: 'Recall latency is dominated by embedding, not by pgvector.',
  sources: [{ url: 'https://example.test/bench', supports: 'the 40ms embedding figure' }],
  confidence: 'medium',
  falsifiedBy: 'a profile showing pgvector above 20ms on a warm index',
  ...over,
});

test('a claim nobody could disprove is REFUSED as a position', () => {
  assert.match(validateResearchClaim(claim({ falsifiedBy: '' }))!, /position, not a finding/);
});

test('a source must say what it actually supports', () => {
  // A link appended at the bottom reads as though it supports every sentence
  // above it.
  const bad = claim({ sources: [{ url: 'https://example.test/x', supports: '' }] });
  assert.match(validateResearchClaim(bad)!, /without saying what it actually supports/);
});

test('no sources means the confidence must be low', () => {
  assert.match(validateResearchClaim(claim({ sources: [], confidence: 'high' }))!, /confidence is low/);
  assert.equal(validateResearchClaim(claim({ sources: [], confidence: 'low' })), null);
});

test('confidence and the falsifier travel WITH the claim', () => {
  // A reader who stops after the first sentence has still seen both.
  const text = describeResearchClaim(claim());
  const lines = text.split('\n');
  assert.match(lines[1]!, /Confidence: medium/);
  assert.match(lines[1]!, /would be wrong if/);
});

test('a well-formed claim passes', () => {
  assert.equal(validateResearchClaim(claim()), null);
});
