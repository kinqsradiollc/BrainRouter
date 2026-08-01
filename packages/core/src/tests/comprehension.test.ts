/**
 * ADR-027 D1 (P9-3) — comprehension measures.
 *
 * §5 leaves open whether measuring this is worth the surveillance risk, so the
 * tests defend the narrowness as much as the arithmetic: it measures
 * SUBSYSTEMS rather than people, it produces candidates rather than
 * assignments, and it says nothing at all when nothing has drifted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessComprehension,
  describeComprehension,
  overallReviewedFraction,
  type SubsystemActivity,
} from '../debt/comprehension.js';

const NOW = '2026-08-01T00:00:00.000Z';
const daysAgo = (n: number): string =>
  new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

const sub = (over: Partial<SubsystemActivity> = {}): SubsystemActivity => ({
  path: 'src/auth/',
  changedLines: 500,
  reviewedLines: 450,
  lastHumanAuthoredAt: daysAgo(10),
  ...over,
});

test('a well-understood subsystem is not a teaching candidate', () => {
  const [assessment] = assessComprehension([sub()], { now: NOW });
  assert.equal(assessment!.reviewedFraction, 0.9);
  assert.equal(assessment!.daysSinceHumanAuthored, 10);
  assert.equal(assessment!.teachingCandidate, false);
});

test('BOTH signals must agree before suggesting teaching mode', () => {
  // Either alone is ordinary: plenty of well-understood code is stable, and
  // plenty of reviewed code is written by someone else.
  const unreadOnly = assessComprehension(
    [sub({ reviewedLines: 50, lastHumanAuthoredAt: daysAgo(5) })], { now: NOW },
  );
  assert.equal(unreadOnly[0]!.teachingCandidate, false, 'recently authored — not drifted');

  const staleOnly = assessComprehension(
    [sub({ reviewedLines: 500, lastHumanAuthoredAt: daysAgo(400) })], { now: NOW },
  );
  assert.equal(staleOnly[0]!.teachingCandidate, false, 'fully reviewed — still understood');

  const both = assessComprehension(
    [sub({ reviewedLines: 50, lastHumanAuthoredAt: daysAgo(400) })], { now: NOW },
  );
  assert.equal(both[0]!.teachingCandidate, true, 'owned and out of touch');
});

test('a never-human-authored subsystem counts as stale', () => {
  const [assessment] = assessComprehension(
    [sub({ reviewedLines: 10, lastHumanAuthoredAt: null })], { now: NOW },
  );
  assert.equal(assessment!.daysSinceHumanAuthored, null);
  assert.equal(assessment!.teachingCandidate, true);
});

test('small subsystems are ignored so the measure does not fill with noise', () => {
  // A three-line config change otherwise looks like total drift, and noise
  // trains people to dismiss the whole measure.
  const [assessment] = assessComprehension(
    [sub({ changedLines: 5, reviewedLines: 0, lastHumanAuthoredAt: daysAgo(400) })], { now: NOW },
  );
  assert.equal(assessment!.teachingCandidate, false);
});

test('thresholds are configurable', () => {
  const activity = [sub({ reviewedLines: 300, lastHumanAuthoredAt: daysAgo(100) })];
  assert.equal(assessComprehension(activity, { now: NOW, reviewedFloor: 0.5 })[0]!.teachingCandidate, false);
  assert.equal(assessComprehension(activity, { now: NOW, reviewedFloor: 0.8 })[0]!.teachingCandidate, true);
  assert.equal(
    assessComprehension(activity, { now: NOW, reviewedFloor: 0.8, staleDays: 365 })[0]!.teachingCandidate,
    false,
    'raising the stale threshold un-flags it',
  );
});

test('a subsystem with no change is treated as fully understood', () => {
  const [assessment] = assessComprehension(
    [sub({ changedLines: 0, reviewedLines: 0 })], { now: NOW },
  );
  assert.equal(assessment!.reviewedFraction, 1);
  assert.equal(assessment!.teachingCandidate, false);
});

test('reviewed lines exceeding changed lines cannot exceed 1', () => {
  // Review data is approximate; a ratio above 1 would render as "140% reviewed".
  const [assessment] = assessComprehension(
    [sub({ changedLines: 100, reviewedLines: 140 })], { now: NOW },
  );
  assert.equal(assessment!.reviewedFraction, 1);
});

test('the report names SUBSYSTEMS and never addresses the person', () => {
  // "auth/ has drifted" is a fact about a codebase. "You have not read your
  // merges" is a fact about a person, and a tool that says the latter becomes
  // something to be managed rather than used.
  const text = describeComprehension(assessComprehension(
    [sub({ reviewedLines: 50, lastHumanAuthoredAt: daysAgo(400) })], { now: NOW },
  ))!;
  assert.match(text, /src\/auth\//);
  assert.doesNotMatch(text, /\byou\b|\byour\b/i);
  assert.doesNotMatch(text, /should|must|warning|failing/i);
});

test('teaching mode is offered, never assigned', () => {
  const text = describeComprehension(assessComprehension(
    [sub({ reviewedLines: 50, lastHumanAuthoredAt: daysAgo(400) })], { now: NOW },
  ))!;
  assert.match(text, /available/, 'an offer, not an instruction');
});

test('nothing drifted produces NO message', () => {
  // Silence is the correct output for a healthy codebase. A measure that always
  // says something trains people to stop reading it.
  assert.equal(describeComprehension(assessComprehension([sub()], { now: NOW })), null);
  assert.equal(describeComprehension([]), null);
});

test('a long list is summarised rather than dumped', () => {
  const many = Array.from({ length: 6 }, (_, i) =>
    sub({ path: `src/mod${i}/`, reviewedLines: 10, lastHumanAuthoredAt: daysAgo(400) }));
  const text = describeComprehension(assessComprehension(many, { now: NOW }))!;
  assert.match(text, /and 3 more/);
});

test('the overall figure is weighted by size, not averaged per subsystem', () => {
  // A thoroughly reviewed one-line fix must not offset an unreviewed
  // thousand-line rewrite, which is what an unweighted mean would do.
  const subsystems = [
    sub({ path: 'a/', changedLines: 1, reviewedLines: 1 }),
    sub({ path: 'b/', changedLines: 999, reviewedLines: 0 }),
  ];
  const fraction = overallReviewedFraction(subsystems);
  assert.ok(fraction < 0.01, `expected near zero, got ${fraction}`);
});

test('an empty codebase is trivially fully understood', () => {
  assert.equal(overallReviewedFraction([]), 1);
});
