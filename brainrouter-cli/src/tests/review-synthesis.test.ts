import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findingKey,
  mergeAndFilterFindings,
  renderReviewReport,
  type ReviewFinding,
} from '../orchestration/reviewSynthesis.js';

const f = (over: Partial<ReviewFinding>): ReviewFinding => ({
  file: 'src/a.ts',
  line: 10,
  severity: 'high',
  confidence: 90,
  summary: 'null deref on user input',
  ...over,
});

test('MAS-P5-T1 findingKey: dedups by (file, line-range, root-cause)', () => {
  // same file+line, near-identical summary → same key
  assert.equal(findingKey(f({})), findingKey(f({ summary: 'Null deref on user input!' })));
  // different file → different key
  assert.notEqual(findingKey(f({})), findingKey(f({ file: 'src/b.ts' })));
  // different line → different key
  assert.notEqual(findingKey(f({})), findingKey(f({ line: 99 })));
  // explicit rootCause overrides summary-hash
  assert.equal(findingKey(f({ rootCause: 'X' })), findingKey(f({ summary: 'totally different text', rootCause: 'X' })));
});

test('MAS-P5-T1 merge: duplicates collapse, max confidence wins, reviewers unioned', () => {
  const synth = mergeAndFilterFindings(
    [
      f({ confidence: 70, reviewer: 'bug-reviewer' }),
      f({ confidence: 88, reviewer: 'instruction-reviewer' }), // same key, higher conf
    ],
    80,
  );
  assert.equal(synth.kept.length, 1);
  assert.equal(synth.kept[0].confidence, 88);
  assert.equal(synth.kept[0].reviewer, 'bug-reviewer+instruction-reviewer');
  assert.equal(synth.dropped.length, 0);
});

test('MAS-P5-T1 filter: below-threshold findings move to dropped, not kept', () => {
  const synth = mergeAndFilterFindings(
    [
      f({ file: 'a.ts', confidence: 95 }),
      f({ file: 'b.ts', confidence: 60 }),
      f({ file: 'c.ts', confidence: 80 }), // exactly at threshold → kept
    ],
    80,
  );
  assert.deepEqual(synth.kept.map((k) => k.file).sort(), ['a.ts', 'c.ts']);
  assert.deepEqual(synth.dropped.map((d) => d.file), ['b.ts']);
  // kept sorted by confidence desc
  assert.equal(synth.kept[0].file, 'a.ts');
});

test('MAS-P5-T1 render: severity-ordered; no-issues message when all dropped', () => {
  const report = renderReviewReport(
    mergeAndFilterFindings(
      [
        f({ file: 'a.ts', severity: 'low', confidence: 85 }),
        f({ file: 'b.ts', severity: 'critical', confidence: 90 }),
      ],
      80,
    ),
    80,
  );
  // critical appears before low
  assert.ok(report.indexOf('b.ts') < report.indexOf('a.ts'));

  const empty = renderReviewReport(mergeAndFilterFindings([f({ confidence: 10 })], 80), 80);
  assert.match(empty, /No issues found at or above confidence 80/);
  assert.match(empty, /1 lower-confidence finding/);
});
