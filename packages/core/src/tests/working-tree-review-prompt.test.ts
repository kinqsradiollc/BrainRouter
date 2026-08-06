/**
 * ADR-028 — the pre-commit review prompt, now assembled in core.
 *
 * It used to be an inline template literal inside the Electron host, so nothing
 * covered it and its copy of the grounding rule drifted unnoticed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkingTreeReviewPrompt } from '../review/workingTreeReview.js';

test("REVIEW.md precedes the default contract so the repo owner's rules win", () => {
  // A policy that arrives after the rule it overrides does not override it.
  const prompt = buildWorkingTreeReviewPrompt({
    reviewInstructions: 'REPO POLICY: never flag missing JSDoc.\n\n',
    diff: 'diff --git a/a.ts b/a.ts',
  });
  assert.ok(prompt.startsWith('REPO POLICY: never flag missing JSDoc.'));
  assert.ok(prompt.indexOf('REPO POLICY') < prompt.indexOf('You are reviewing the uncommitted changes'));
});

test('the change-impact block is omitted entirely when the graph has nothing to say', () => {
  const empty = buildWorkingTreeReviewPrompt({ changeContext: '', diff: 'D' });
  const filled = buildWorkingTreeReviewPrompt({ changeContext: 'Change impact: a.ts', diff: 'D' });
  assert.equal(empty, buildWorkingTreeReviewPrompt({ diff: 'D' }));
  assert.match(filled, /Change impact: a\.ts\n\nDiff:\nD/);
  assert.match(empty, /\n\nDiff:\nD/);
});

test('the working-tree reviewer is told it can open files, not just read the hunk', () => {
  const prompt = buildWorkingTreeReviewPrompt({ diff: 'D' });
  assert.match(prompt, /read_file/);
  assert.match(prompt, /NEGATIVE CONTROL/);
  assert.doesNotMatch(prompt, /NO tools/, 'this reviewer has tools; claiming otherwise suppresses findings');
});

test('the working-tree review still sweeps security, because it is the only local one', () => {
  // The code-review lens hands vulnerabilities to a separate reviewer that no
  // local surface runs. Routing this prompt onto it would silently drop
  // security from every pre-commit review.
  assert.match(buildWorkingTreeReviewPrompt({ diff: 'D' }), /security issues/);
});

test('the reviewer is asked for the JSON tail the local parser consumes', () => {
  const prompt = buildWorkingTreeReviewPrompt({ diff: 'D' });
  assert.match(prompt, /```json/);
  assert.match(prompt, /"severity"/);
});
