/**
 * ADR-027 D4 (P8-3) — page and region provenance.
 *
 * The justification is a claim about people, not data: a character offset is
 * verifiable in principle but nobody counts to it, so a citation carrying only
 * offsets gets trusted without being checked — the same outcome as no citation,
 * dressed as rigour. A page and a rectangle can be checked in two seconds, and
 * a two-second check actually happens.
 *
 * Which makes the mapping the sensitive part: this is where a citation silently
 * drifts to the wrong page.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  provenanceForSpan,
  describeProvenance,
  runProblems,
  type TextRun,
} from '../document/provenance.js';

const run = (start: number, end: number, page: number, x = 0, y = 0): TextRun =>
  ({ start, end, region: { page, x, y, width: 100, height: 10 } });

const RUNS: TextRun[] = [
  run(0, 50, 0, 0, 700),
  run(50, 100, 0, 0, 680),
  run(100, 160, 1, 0, 700),
];

test('a span inside one run resolves to that page', () => {
  const provenance = provenanceForSpan(RUNS, { start: 10, end: 40 });
  assert.deepEqual(provenance.pages, [0]);
  assert.equal(provenance.regions.length, 1);
  assert.equal(provenance.partial, false);
});

test('a span crossing a page boundary reports both pages', () => {
  const provenance = provenanceForSpan(RUNS, { start: 80, end: 120 });
  assert.deepEqual(provenance.pages, [0, 1]);
  assert.equal(provenance.regions.length, 2, 'one rectangle per page');
});

test('runs on the same page union into one rectangle', () => {
  // Two separate highlights for adjacent lines is visual noise; one box around
  // the cited passage is what a reader can check at a glance.
  const provenance = provenanceForSpan(RUNS, { start: 10, end: 90 });
  assert.deepEqual(provenance.pages, [0]);
  const region = provenance.regions[0]!;
  assert.equal(region.y, 680, 'bottom of the lower run');
  assert.equal(region.height, 30, 'spans both lines: 680→710');
});

test('overlap, not containment, decides whether a run counts', () => {
  // Requiring containment would drop the first and last runs of nearly every
  // citation — the two that show where it starts and ends.
  const provenance = provenanceForSpan(RUNS, { start: 45, end: 55 });
  assert.deepEqual(provenance.pages, [0]);
  assert.equal(provenance.regions[0]!.height, 30, 'both runs are touched');
});

test('a run ending exactly where the span starts does not touch it', () => {
  // Half-open. Including it would highlight the preceding word.
  const provenance = provenanceForSpan([run(0, 50, 0), run(50, 100, 1)], { start: 50, end: 60 });
  assert.deepEqual(provenance.pages, [1], 'page 0 ends exactly at 50 and is excluded');
});

test('a span with no layout is reported as unverifiable, not silently empty', () => {
  const provenance = provenanceForSpan(RUNS, { start: 500, end: 600 });
  assert.deepEqual(provenance.pages, []);
  assert.equal(provenance.partial, true);
  assert.match(describeProvenance(provenance), /cannot be verified/);
});

test('layout that stops short of the span is marked partial', () => {
  // The citation still resolves; its highlight is incomplete. Saying so is the
  // difference between a partial answer and a wrong one.
  const provenance = provenanceForSpan([run(0, 50, 0)], { start: 10, end: 200 });
  assert.deepEqual(provenance.pages, [0]);
  assert.equal(provenance.partial, true);
  assert.match(describeProvenance(provenance), /partial/);
});

test('an empty or inverted span resolves to nothing without throwing', () => {
  for (const span of [{ start: 10, end: 10 }, { start: 40, end: 10 }]) {
    const provenance = provenanceForSpan(RUNS, span);
    assert.deepEqual(provenance.pages, []);
    assert.equal(provenance.partial, false, 'an empty span is not a partial one');
  }
});

test('page numbers are 1-based for the reader', () => {
  // The reader is looking at a number printed on a document, not an array index.
  assert.equal(describeProvenance(provenanceForSpan(RUNS, { start: 10, end: 20 })), 'page 1');
  assert.equal(describeProvenance(provenanceForSpan(RUNS, { start: 80, end: 120 })), 'pages 1–2');
});

test('overlapping runs are reported — a span there resolves to two places', () => {
  // Which page a reader is shown would become an accident of iteration order.
  const problems = runProblems([run(0, 60, 0), run(50, 100, 1)]);
  assert.ok(problems.some((p) => /Runs overlap/.test(p)));
});

test('malformed runs are reported before citations are built on them', () => {
  assert.ok(runProblems([run(50, 50, 0)]).some((p) => /non-positive length/.test(p)));
  assert.ok(runProblems([{ start: 0, end: 10, region: { page: 0, x: 0, y: 0, width: -5, height: 10 } }])
    .some((p) => /negative-size region/.test(p)));
  assert.ok(runProblems([{ start: 0, end: 10, region: { page: -1, x: 0, y: 0, width: 5, height: 10 } }])
    .some((p) => /negative page number/.test(p)));
});

test('a well-formed run set reports no problems', () => {
  assert.deepEqual(runProblems(RUNS), []);
  assert.deepEqual(runProblems([]), []);
});
