/**
 * ADR-033 D4/D5 — the line is computed, and the reflection may delete.
 *
 * The behaviour the ADR says it will be judged on lives in the first test: a
 * finding whose quoted evidence sits on line 42 is published on line 42, even
 * when the model said 7. The rest pin the failure modes that make that claim
 * worth anything — an unplaceable finding loses its line instead of anchoring
 * to a wrong one, and a reflection outage never empties a review.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiffLineIndex,
  computeFindingPosition,
  positionReviewFindings,
} from '../review/findingPosition.js';
import {
  applyReflection,
  parseReflectionOutput,
  reflectOnReviewFindings,
} from '../review/reviewReflection.js';
import type { ParsedReviewFinding } from '../review/reviewFindings.js';

const DIFF = [
  'diff --git a/src/pay.ts b/src/pay.ts',
  '--- a/src/pay.ts',
  '+++ b/src/pay.ts',
  '@@ -40,2 +40,5 @@',
  ' export function pay(amount) {',
  '+  const total = amount * rate;',
  '+  return charge(total);',
  '+}',
  ' // trailing context',
].join('\n');

function finding(overrides: Partial<ParsedReviewFinding>): ParsedReviewFinding {
  return {
    file: 'src/pay.ts',
    severity: 'high',
    confidence: 80,
    summary: 'rate may be undefined',
    ...overrides,
  };
}

test('the quoted evidence decides the line, not the model’s memory of it', () => {
  const index = buildDiffLineIndex(DIFF);
  const position = computeFindingPosition(
    finding({ line: 7, codeExcerpt: '  const total = amount * rate;' }),
    index,
  );
  assert.equal(position.path, 'src/pay.ts');
  assert.equal(position.line, 41);
  assert.equal(position.kind, 'excerpt_relocated');
});

test('a multi-line excerpt establishes the end line too', () => {
  const index = buildDiffLineIndex(DIFF);
  const position = computeFindingPosition(
    finding({ codeExcerpt: '  const total = amount * rate;\n  return charge(total);' }),
    index,
  );
  assert.equal(position.line, 41);
  assert.equal(position.endLine, 42);
});

test('a line that cannot be established is not published at all', () => {
  const index = buildDiffLineIndex(DIFF);
  const nowhere = computeFindingPosition(finding({ line: 900 }), index);
  assert.equal(nowhere.kind, 'file_only');
  assert.equal(nowhere.line, undefined);

  const elsewhere = computeFindingPosition(finding({ file: 'src/other.ts', line: 41 }), index);
  assert.equal(elsewhere.kind, 'path_unknown');
  assert.equal(elsewhere.path, null);
});

test('positioning strips a one-click replacement whose range moved', () => {
  const [positioned] = positionReviewFindings(
    [finding({ line: 7, endLine: 7, codeExcerpt: '  const total = amount * rate;', replacement: 'const total = 0;' })],
    DIFF,
  );
  assert.equal(positioned.finding.line, 41);
  assert.equal(positioned.finding.replacement, undefined);
});

test('a model line the diff actually shows is confirmed, not moved', () => {
  const index = buildDiffLineIndex(DIFF);
  const position = computeFindingPosition(finding({ line: 42 }), index);
  assert.equal(position.kind, 'model_line_confirmed');
  assert.equal(position.line, 42);
});

test('the reflection returns FEWER findings than it received', async () => {
  const findings = [
    finding({ summary: 'a real bug' }),
    finding({ summary: 'restates what the code does' }),
    finding({ summary: 'a real bug, again' }),
  ];
  const result = await reflectOnReviewFindings(findings, {
    complete: async () =>
      JSON.stringify({
        verdicts: [
          { index: 1, verdict: 'keep', rank: 1 },
          { index: 2, verdict: 'drop', reason: 'no evidence supports the claim' },
          { index: 3, verdict: 'duplicate', duplicateOf: 1, reason: 'same issue as finding 1' },
        ],
      }),
  });
  assert.equal(result.reflected, true);
  assert.equal(result.findings.length, 1);
  assert.equal(result.dropped, 1);
  assert.equal(result.merged, 1);
});

test('an unexplained deletion is refused, and an outage keeps every finding', async () => {
  const findings = [finding({ summary: 'one' }), finding({ summary: 'two' })];
  const unexplained = parseReflectionOutput(
    JSON.stringify({ verdicts: [{ index: 1, verdict: 'drop' }] }),
    2,
  );
  assert.equal(unexplained, null, 'a drop with no reason was accepted');

  const outage = await reflectOnReviewFindings(findings, {
    complete: async () => {
      throw new Error('gateway 502');
    },
  });
  assert.equal(outage.reflected, false);
  assert.equal(outage.findings.length, 2);
});

test('a finding with no verdict is kept, so a truncated reply loses nothing', () => {
  const findings = [finding({ summary: 'one' }), finding({ summary: 'two' }), finding({ summary: 'three' })];
  const applied = applyReflection(findings, [
    { index: 3, verdict: 'keep', rank: 1 },
  ]);
  assert.equal(applied.findings.length, 3);
  assert.equal(applied.findings[0].summary, 'three', 'the rank was not applied');
});
