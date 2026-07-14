import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_TABS, nextModelTabIndex } from './modelTabs.js';

test('model settings tabs support arrow, Home, End, and wraparound navigation', () => {
  assert.equal(nextModelTabIndex(0, 'ArrowLeft'), MODEL_TABS.length - 1);
  assert.equal(nextModelTabIndex(MODEL_TABS.length - 1, 'ArrowRight'), 0);
  assert.equal(nextModelTabIndex(2, 'Home'), 0);
  assert.equal(nextModelTabIndex(2, 'End'), MODEL_TABS.length - 1);
  assert.equal(nextModelTabIndex(2, 'Enter'), null);
});
