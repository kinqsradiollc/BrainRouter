/**
 * ADR-028 — the grounding rule has exactly one definition.
 *
 * "How to reason about review evidence" was hand-copied into five prompts and
 * drifted apart independently between copies; realigning them by hand fixes
 * today and guarantees tomorrow's drift. These tests fail the moment a surface
 * starts carrying its own wording again, and they assert the RULE, never the
 * envelope each surface wraps it in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodeReviewContract } from '../review/codeReviewContract.js';
import { REVIEW_OUTPUT_CONTRACT } from '../review/reviewFindings.js';
import {
  HUNK_RULE,
  NEGATIVE_CONTROL,
  UNVERIFIED_CLAIM,
  buildGroundingClause,
} from '../review/reviewGrounding.js';
import { buildSecurityReviewContract } from '../review/securityReview.js';
import { buildWorkingTreeReviewPrompt } from '../review/workingTreeReview.js';
import { ENGINEERING_COMPATIBILITY_AGENT_PROMPTS } from '../orchestration/roles/rolePromptSelection.js';

test('both modes that can look carry the same negative-control rule', () => {
  for (const mode of ['attached-context', 'read-only-tools'] as const) {
    const clause = buildGroundingClause(mode);
    assert.ok(clause.includes(HUNK_RULE), `${mode} dropped the hunk rule`);
    assert.ok(clause.includes(NEGATIVE_CONTROL), `${mode} dropped the negative control`);
  }
});

test('the diff-only mode never licenses a tool the reviewer does not have', () => {
  // A toolless model told to confirm a finding with `read_file` concludes it
  // could not verify anything and returns [] — a silent review that is
  // indistinguishable from a clean one on the surface that gates merges.
  const clause = buildGroundingClause('diff-only');
  assert.match(clause, /NO tools/);
  assert.doesNotMatch(clause, /read_file|grep_search|repository context/i);
});

test('the tools mode never promises repository context that was not attached', () => {
  const clause = buildGroundingClause('read-only-tools');
  assert.doesNotMatch(clause, /cannot request more files/i);
  assert.doesNotMatch(clause, /repository context/i);
});

test('one function supplies the rule to every surface that can look past the hunk', () => {
  const tools = buildGroundingClause('read-only-tools');
  assert.ok(
    buildWorkingTreeReviewPrompt({ diff: 'x' }).includes(tools),
    'the working-tree reviewer went back to its own copy',
  );
  assert.ok(
    ENGINEERING_COMPATIBILITY_AGENT_PROMPTS.reviewer.includes(tools),
    'the delegated reviewer role went back to its own copy',
  );
  assert.ok(
    REVIEW_OUTPUT_CONTRACT.includes(UNVERIFIED_CLAIM),
    'the local output contract went back to its own honesty bar',
  );

  const attached = buildGroundingClause('attached-context');
  for (const build of [buildSecurityReviewContract, buildCodeReviewContract]) {
    assert.ok(
      build({ repositoryContext: true }).includes(attached),
      'a grounded bot contract went back to its own copy',
    );
  }
});

test('every reviewing surface still requests only fields the parser reads', () => {
  // The JSON tails are deliberately NOT generated — their field descriptions
  // differ per lens — so the shared invariant is asserted here instead.
  const tails = [
    buildSecurityReviewContract(),
    buildCodeReviewContract(),
    REVIEW_OUTPUT_CONTRACT,
  ];
  for (const tail of tails) {
    assert.match(tail, /```json/);
    assert.match(tail, /"file"/);
    assert.match(tail, /"severity"/);
    assert.match(tail, /"summary"/);
  }
});
