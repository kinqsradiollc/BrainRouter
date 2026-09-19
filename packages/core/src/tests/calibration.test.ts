/**
 * ADR-061 D7 — the tier grades itself, and the grade has to be hard to pass.
 *
 * Two failure modes matter more than the arithmetic. A classifier that is
 * confidently wrong must fail; and a classifier that hedges at 0.5 on
 * everything — perfectly calibrated, perfectly useless — must fail too, which
 * is the reason Brier sits beside ECE rather than ECE alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALIBRATION_MIN_SAMPLES,
  assertedProbability,
  assessCalibration,
  samplesFromDecisions,
  type CalibrationSample,
} from '../decision/calibration.js';
import type { DecisionEntry } from '../decision/recentDecisions.js';

/** `n` decisions stated at `probability`, right `hitRate` of the time. */
function batch(probability: number, hitRate: number, n: number): CalibrationSample[] {
  return Array.from({ length: n }, (_, i) => ({ probability, correct: i < Math.round(n * hitRate) }));
}

const entry = (over: Partial<DecisionEntry>): DecisionEntry => ({
  consumer: 'shell', question: 'risky', kind: 'noul', value: 0.9,
  provider: 'local', latencyMs: 12, ts: 1, ...over,
});

test('a classifier that means what it says passes', () => {
  const samples = [...batch(0.1, 0.1, 40), ...batch(0.5, 0.5, 40), ...batch(0.9, 0.9, 40)];
  const report = assessCalibration('local', samples);
  assert.equal(report.verdict, 'calibrated');
  assert.ok(report.ece < 0.05, `ECE ${report.ece}`);
  assert.match(report.summary, /is calibrated over 120 decisions/);
});

test('confidently wrong fails, and the summary says where', () => {
  const samples = [...batch(0.95, 0.4, 60), ...batch(0.1, 0.1, 60)];
  const report = assessCalibration('local', samples);
  assert.equal(report.verdict, 'uncalibrated');
  assert.match(report.summary, /NOT calibrated/);
  assert.match(report.summary, /overconfident around 0\.95, where it was right 40% of 60/);
  assert.match(report.summary, /advisory: recorded and shown, with the rules deciding/);
});

test('hedging at 0.5 forever is not calibration — this is why Brier is here', () => {
  const samples = batch(0.5, 0.5, 100);
  const report = assessCalibration('local', samples);
  assert.ok(report.ece < 0.01, 'ECE alone is perfectly happy with it');
  assert.equal(report.brier, 0.25);
  assert.equal(report.verdict, 'uncalibrated', 'a classifier that never commits tells you nothing');
});

test('underconfidence is named as underconfidence, not lumped in', () => {
  const report = assessCalibration('local', [...batch(0.2, 0.9, 60), ...batch(0.9, 0.9, 60)]);
  assert.equal(report.verdict, 'uncalibrated');
  assert.match(report.summary, /underconfident around 0\.20/);
});

test('too few decisions is a non-verdict, never a pass', () => {
  const report = assessCalibration('local', batch(0.9, 0.9, 5), { unlabelled: 12 });
  assert.equal(report.verdict, 'insufficient');
  assert.equal(report.ece, 0, 'no number is offered that could be mistaken for a reading');
  assert.match(report.summary, new RegExp(`5 of ${CALIBRATION_MIN_SAMPLES} decisions needed`));
  assert.match(report.summary, /12 more are recorded but nothing has said yet/);
});

test('a certain answer is graded, not dropped off the end of the last bucket', () => {
  const report = assessCalibration('local', batch(1, 1, 40));
  const top = report.bins[report.bins.length - 1]!;
  assert.equal(top.samples, 40, '1.0 belongs to the top bucket');
  assert.equal(report.verdict, 'calibrated');
});

test('a noul is graded on its own value; a choice on its stated confidence', () => {
  assert.equal(assertedProbability(entry({ kind: 'noul', value: 0.42, confidence: 0.9 })), 0.42,
    'for a noul the number IS the claim — confidence would grade the wrong thing');
  assert.equal(assertedProbability(entry({ kind: 'choice', value: 'billing', confidence: 0.7 })), 0.7);
  assert.equal(assertedProbability(entry({ kind: 'choice', value: 'billing' })), undefined,
    'a key with no confidence asserts no probability, so there is nothing to grade');
});

test('the rules floor is excluded, and unlabelled decisions are counted, not assumed', () => {
  const entries: DecisionEntry[] = [
    entry({ value: 0.9, correct: true }),
    entry({ value: 0.8, correct: false }),
    entry({ value: 0.7 }),                                  // nothing ever said
    entry({ value: 1, provider: 'rules', correct: true }),   // certain by construction
    entry({ value: 0.5, provider: 'other', correct: true }), // a different provider
    entry({ kind: 'choice', value: 'a', correct: true }),    // no confidence stated
  ];
  const { samples, unlabelled } = samplesFromDecisions(entries, 'local');
  assert.deepEqual(samples, [{ probability: 0.9, correct: true }, { probability: 0.8, correct: false }]);
  // "unlabelled" means gradeable but ungraded — a decision still waiting to
  // find out if it was right. The confidence-less choice is neither: it knows
  // the outcome and asserted no probability, so there is nothing to compare.
  // Counting it here would report "nothing has said yet" about a decision
  // something HAS said about.
  assert.equal(unlabelled, 1, 'only the noul that nothing has graded yet');

  assert.deepEqual(samplesFromDecisions(entries, 'rules').samples, [],
    'grading the floor would measure a heuristic\'s luck and flatter whatever sits above it');
});

// ---------------------------------------------------------------------------
// D7's other half: what a demotion actually does to a gate.
// ---------------------------------------------------------------------------

test('an advisory provider keeps answering; the rules keep deciding', async () => {
  const { createDecisionPort } = await import('../decision/port.js');
  const port = createDecisionPort({
    advisory: 'local is NOT calibrated over 40 decisions (ECE 0.41, Brier 0.38)',
    provider: {
      name: 'local',
      async answer(_state, questions) {
        return Object.fromEntries(Object.keys(questions).map((id) => [id, { kind: 'noul' as const, value: 0.97, confidence: 0.9 }]));
      },
    },
  });
  const answers = await port.ask('rm -rf /', {
    risky: { kind: 'noul', instructions: 'Is this risky?', rulesAnswer: 0 },
  });
  const answer = answers.risky!;

  assert.equal(answer.value, 0, 'the gate gets the rules floor, not the demoted 0.97');
  assert.equal(answer.provider, 'rules');
  assert.match(answer.fellBack ?? '', /NOT calibrated over 40 decisions/);
  // A demoted classifier that went quiet could never be re-qualified, so what
  // it said still rides along and still lands in the record.
  assert.deepEqual(answer.advised, { value: 0.97, confidence: 0.9, provider: 'local' });
});

test('a demoted answer is recorded and shown, with what it advised', async () => {
  const { decisionEntry, describeDecision } = await import('../decision/recentDecisions.js');
  const line = describeDecision(decisionEntry('shell', 'risky', {
    kind: 'noul', value: 0, provider: 'rules', latencyMs: 8,
    fellBack: 'local is NOT calibrated',
    advised: { value: 0.97, provider: 'local' },
  }, { outcome: 'allow', correct: false }));
  assert.match(line, /advised 0\.97 \(not used\)/);
  assert.match(line, /overruled/);
});
