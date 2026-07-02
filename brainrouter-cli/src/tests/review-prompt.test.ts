import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt } from '../cli/commands/reviewPrompt/index.js';
import { capText } from '../runtime/gitContext.js';

const base = {
  scope: 'git diff HEAD',
  slug: 'review-123',
  reportPath: '.brainrouter/workflows/review-123/review.md',
  diff: 'diff --git a/x.ts b/x.ts\n+const a = 1;',
  diffTruncated: false,
  fix: false,
} as const;

test('REVIEW-FIX buildReviewPrompt injects the diff so no explorer spawn is needed', () => {
  const p = buildReviewPrompt({ ...base, accessMode: 'write' });
  assert.match(p, /## The diff under review/);
  assert.match(p, /const a = 1;/);
  assert.match(p, /do NOT spawn a child just to read it/i);
  // The summary step no longer tells a child to "read the diff".
  assert.doesNotMatch(p, /role=explorer\) to read the diff/);
});

test('REVIEW-FIX write/shell session has the PARENT write review.md', () => {
  for (const accessMode of ['write', 'shell'] as const) {
    const p = buildReviewPrompt({ ...base, accessMode });
    assert.match(p, /## Step 7: Output\n/);
    assert.match(p, /`write_file` to `\.brainrouter\/workflows\/review-123\/review\.md`/);
    assert.doesNotMatch(p, /read-only session/);
  }
});

test('REVIEW-FIX read session prints to chat and never writes (the bug that failed)', () => {
  const p = buildReviewPrompt({ ...base, accessMode: 'read' });
  assert.match(p, /read-only session/);
  assert.match(p, /Do NOT call `write_file`/);
  assert.match(p, /do NOT spawn a child to write/);
  assert.match(p, /Re-run `\/review` in write mode/);
  // No unconditional write_file instruction for the report in read mode.
  assert.doesNotMatch(p, /`write_file` to `\.brainrouter\/workflows\/review-123\/review\.md`/);
});

test('REVIEW-FIX --fix adds the apply+verify step (write/shell only)', () => {
  const p = buildReviewPrompt({ ...base, accessMode: 'shell', fix: true });
  assert.match(p, /## Step 8: Apply fixes \(--fix\)/);
  assert.match(p, /run the project build \+ tests/);
  // Without --fix there is no Step 8.
  const noFix = buildReviewPrompt({ ...base, accessMode: 'shell', fix: false });
  assert.doesNotMatch(noFix, /## Step 8/);
});

test('REVIEW-FIX prompt is a single self-contained instruction set (no generic five-axis path)', () => {
  const p = buildReviewPrompt({ ...base, accessMode: 'write' });
  // The high-signal filter is present and authoritative...
  assert.match(p, /HIGH SIGNAL ONLY filter/);
  assert.match(p, /You are the lead reviewer\. \*\*Drive every step yourself\*\*|lead reviewer/);
  // ...and the contradicting generic five-axis checklist language is absent.
  assert.doesNotMatch(p, /five-axis|Readability & Simplicity|Performance\n/i);
});

test('REVIEW-FIX truncation note appears only when the diff was capped', () => {
  assert.match(buildReviewPrompt({ ...base, accessMode: 'read', diffTruncated: true }), /diff truncated above/);
  assert.doesNotMatch(buildReviewPrompt({ ...base, accessMode: 'read', diffTruncated: false }), /diff truncated above/);
});

test('REVIEW-FIX capText caps oversize text with a marker and leaves small text intact', () => {
  const small = capText('abc', 100);
  assert.equal(small.truncated, false);
  assert.equal(small.text, 'abc');
  const big = capText('x'.repeat(500), 100);
  assert.equal(big.truncated, true);
  assert.match(big.text, /truncated at 100 chars/);
  assert.ok(big.text.length < 500);
});
