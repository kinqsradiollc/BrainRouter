import test from 'node:test';
import assert from 'node:assert/strict';
import { devReviewAssuranceDetail } from './reviewFixtures.js';

test('development bridge fixture carries the same protocol assurance values as the host query', () => {
  const detail = devReviewAssuranceDetail('review-dev-1');
  assert.equal(detail.assurance?.run.id, 'run-dev-1');
  assert.equal(detail.assurance?.run.revision.headSha, 'abc123def456');
  assert.equal(detail.assurance?.run.coverage.status, 'partial');
  assert.equal(detail.assurance?.run.stages[0].status, 'partial');
  assert.equal(detail.assurance?.findings[0].state, 'insufficient_evidence');
  assert.equal(detail.assurance?.findings[0].verifier?.state, 'insufficient_evidence');
});

test('development bridge fixture rejects a different review id', () => {
  assert.throws(() => devReviewAssuranceDetail('other-review'), /not found/);
});
