/**
 * ADR-028 F7 — the comprehension review.
 *
 * The properties that keep this from becoming a grading tool: trivia is
 * refused, a disagreement is a FINDING rather than a mark, the agent can be the
 * one who is wrong, and the outcome names gaps rather than a score.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateQuestion, validateReview, judgeAnswer, toFinding,
  summarizeReview, describeOutcome, buildJudgePrompt, MAX_QUESTIONS,
  type ComprehensionQuestion, type ComprehensionReview,
} from '../comprehension/comprehensionReview.js';

const q = (over: Partial<ComprehensionQuestion> & { id: string }): ComprehensionQuestion => ({
  form: 'free_text', focus: 'consequence',
  prompt: 'What happens when two devices edit the same field offline?',
  expected: 'both versions are kept and marked conflicted',
  explanation: 'Concurrent text edits are never resolved silently — both survive for a human to pick.',
  ...over,
});

const review = (questions: ComprehensionQuestion[]): ComprehensionReview => ({
  id: 'r1', subject: 'the planner merge rules', questions, createdAt: '2026-08-04T12:00:00.000Z',
});

/* -------------------------------------------------------------- authoring */

test('trivia is REFUSED — you can grep for it', () => {
  // The check that keeps this from degenerating. The value is entirely in what
  // the diff cannot show.
  for (const bad of ['Which file is mergeOwnedItem defined in?', 'What line does the guard start on?']) {
    assert.match(validateQuestion(q({ id: 'x', prompt: bad }))!, /trivia/);
  }
});

test('every question must carry an explanation', () => {
  // Without it a wrong answer teaches nothing and the review becomes a score.
  assert.match(validateQuestion(q({ id: 'x', explanation: '' }))!, /explanation/);
});

test('multiple choice needs three real options', () => {
  assert.match(
    validateQuestion(q({ id: 'x', form: 'multiple_choice', options: ['a', 'b'] }))!,
    /coin flip/,
  );
  assert.match(
    validateQuestion(q({ id: 'x', form: 'multiple_choice', options: ['a', 'a', 'b'] }))!,
    /identical/,
  );
});

test('a review is between three and seven questions', () => {
  assert.match(validateReview(review([q({ id: '1' }), q({ id: '2' })]))!, /at least/);
  const many = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => q({ id: `q${i}` }));
  assert.match(validateReview(review(many))!, /homework/);
});

test('a review testing one thing four ways is refused', () => {
  const same = Array.from({ length: 4 }, (_, i) => q({ id: `q${i}`, focus: 'consequence' }));
  assert.match(validateReview(review(same))!, /same focus/);
});

test('a varied, well-formed review passes', () => {
  assert.equal(validateReview(review([
    q({ id: '1', focus: 'consequence' }),
    q({ id: '2', focus: 'rationale' }),
    q({ id: '3', focus: 'boundary' }),
  ])), null);
});

/* -------------------------------------------------------------- answering */

test('free text is NOT judged by string matching — it asks the model', () => {
  // The failure this avoids: a heuristic marked "it keeps both and flags them
  // as conflicted" wrong against "both versions are kept and marked
  // conflicted". Someone who understands the code perfectly, told they were
  // wrong by the feature meant to help them understand, does not come back.
  const question = q({ id: '1', expected: 'both versions are kept and marked conflicted' });
  assert.equal(judgeAnswer(question, 'it keeps both and flags them as conflicted'), 'needs_model_judgement');
  assert.equal(judgeAnswer(question, 'the newer one wins'), 'needs_model_judgement');
});

test('the judge prompt invites the model to find ITSELF wrong', () => {
  // Without it the natural behaviour is to defend the expected answer, which
  // makes every disagreement the human's fault and loses the case where they
  // spotted a real defect.
  const prompt = buildJudgePrompt(q({ id: '1' }), 'I think it drops the older edit');
  assert.match(prompt, /Different wording is FINE/);
  assert.match(prompt, /the expected answer is the one at fault/);
  assert.match(prompt, /I think it drops the older edit/);
});

test('an unjudged answer is neither a finding nor a gap', () => {
  const r = review([q({ id: '1' }), q({ id: '2' }), q({ id: '3', focus: 'rationale' })]);
  const outcome = summarizeReview(r, [
    { questionId: '1', answer: 'something', verdict: 'needs_model_judgement' },
  ]);
  assert.equal(outcome.findings.length, 0);
  assert.deepEqual(outcome.gaps, [], 'nothing was established, so nothing is claimed');
});

test('an empty answer is SKIPPED, not wrong', () => {
  // "I don't know" is legitimate and more useful than a guess.
  assert.equal(judgeAnswer(q({ id: '1' }), null), 'skipped');
  assert.equal(judgeAnswer(q({ id: '1' }), '   '), 'skipped');
});

test('multiple choice is exact', () => {
  const mc = q({ id: '1', form: 'multiple_choice', options: ['a', 'b', 'c'], expected: 'b' });
  assert.equal(judgeAnswer(mc, 'b'), 'matches');
  assert.equal(judgeAnswer(mc, 'a'), 'differs');
});

/* --------------------------------------------------------------- findings */

test('a disagreement produces a FINDING with both positions', () => {
  // Not a mark. A review that can only find the human wanting is a grading
  // tool, and grading tools get closed.
  const finding = toFinding(q({ id: '1' }), 'I think the newer edit just wins');
  assert.equal(finding.mine.length > 0, true);
  assert.equal(finding.yours, 'I think the newer edit just wins');
});

test('a RATIONALE disagreement may mean the AGENT misread the requirement', () => {
  // The agent chose the approach, so its explanation is a claim about someone
  // else's intent — a confident contradiction is evidence worth taking
  // seriously, and is how this finds a bug rather than a gap.
  const finding = toFinding(q({ id: '1', focus: 'rationale' }), 'we agreed on the other approach');
  assert.equal(finding.resolution, 'agent_may_be_wrong');
});

/* --------------------------------------------------------------- outcomes */

test('the outcome names GAPS, never a score', () => {
  const r = review([
    q({ id: '1', focus: 'consequence' }),
    q({ id: '2', focus: 'rationale' }),
    q({ id: '3', focus: 'boundary' }),
  ]);
  const outcome = summarizeReview(r, [
    { questionId: '1', answer: 'right', verdict: 'matches' },
    { questionId: '2', answer: 'wrong', verdict: 'differs' },
    { questionId: '3', answer: null, verdict: 'skipped' },
  ]);
  const text = describeOutcome(outcome);
  assert.doesNotMatch(text, /\d\s*\/\s*\d/, 'no score');
  assert.doesNotMatch(text, /correct|wrong|passed|failed/i);
  assert.match(text, /why this approach was chosen/);
  assert.match(text, /may be MY misreading/, 'the agent owns its share');
});

test('a skip contributes a gap — it identifies the hole precisely', () => {
  const r = review([q({ id: '1', focus: 'boundary' }), q({ id: '2' }), q({ id: '3', focus: 'rationale' })]);
  const outcome = summarizeReview(r, [{ questionId: '1', answer: null, verdict: 'skipped' }]);
  assert.deepEqual(outcome.gaps, ['boundary']);
  assert.equal(outcome.skipped, 1);
});

test('a fully matching review says so without congratulating anyone', () => {
  const r = review([q({ id: '1' }), q({ id: '2' }), q({ id: '3', focus: 'rationale' })]);
  const outcome = summarizeReview(r, [{ questionId: '1', answer: 'yes', verdict: 'matches' }]);
  const text = describeOutcome(outcome);
  assert.match(text, /matches the one it was built from/);
  assert.doesNotMatch(text, /well done|great|correct/i);
});
