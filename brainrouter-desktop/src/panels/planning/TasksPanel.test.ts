import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestedTaskKindTag } from './TasksPanel.js';

test('MC-B6 desktop suggested-task tags stay compact for the Tasks panel', () => {
  assert.equal(suggestedTaskKindTag('failing-checks'), 'checks');
  assert.equal(suggestedTaskKindTag('merge-conflict'), 'conflict');
  assert.equal(suggestedTaskKindTag('unresolved-reviews'), 'reviews');
  assert.equal(suggestedTaskKindTag('labeled-issue'), 'issue');
  assert.equal(suggestedTaskKindTag('custom-provider'), 'custom-provider');
});
