import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldApplyTaskTranscript, shouldApplyWorkflowDetail } from './taskTranscriptRouting.js';

test('shouldApplyTaskTranscript accepts only the open task card', () => {
  assert.equal(shouldApplyTaskTranscript({ id: 'review-1', kind: 'task' }, { id: 'review-1', kind: 'task' }), true);
  assert.equal(shouldApplyTaskTranscript({ id: 'review-1', kind: 'task' }, { id: 'review-2', kind: 'task' }), false);
  assert.equal(shouldApplyTaskTranscript({ id: 'review-1', kind: 'task' }, { id: 'review-1', kind: 'worker' }), false);
  assert.equal(shouldApplyTaskTranscript(null, { id: 'review-1', kind: 'task' }), false);
});

test('shouldApplyWorkflowDetail accepts only the open workflow card', () => {
  assert.equal(shouldApplyWorkflowDetail({ slug: 'build' }, { slug: 'build' }), true);
  assert.equal(shouldApplyWorkflowDetail({ slug: 'build' }, { slug: 'review' }), false);
  assert.equal(shouldApplyWorkflowDetail(null, { slug: 'build' }), false);
});
