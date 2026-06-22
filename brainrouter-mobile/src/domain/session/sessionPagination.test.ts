import test from 'node:test';
import assert from 'node:assert/strict';
import { toggleVisible, moreLabel, showToggle, SESSION_BASE } from './sessionPagination.js';

test('toggleVisible grows by a page, then collapses to base', () => {
  assert.equal(toggleVisible(7, 30, 10, 7), 17, 'grow by a page');
  assert.equal(toggleVisible(17, 30, 10, 7), 27);
  assert.equal(toggleVisible(27, 30, 10, 7), 30, 'capped at total');
  assert.equal(toggleVisible(30, 30, 10, 7), 7, 'all shown → collapse to base');
});

test('toggleVisible never exceeds total', () => {
  assert.equal(toggleVisible(7, 9, 10, 7), 9);
});

test('moreLabel shows remaining count, then "Show fewer", then nothing', () => {
  assert.equal(moreLabel(30, 7), 'Show 23 more');
  assert.equal(moreLabel(30, 30), 'Show fewer');
  assert.equal(moreLabel(5, 5), '', 'fits in base → no toggle');
  assert.equal(moreLabel(SESSION_BASE, SESSION_BASE), '');
});

test('showToggle: only when the list exceeds the base', () => {
  assert.equal(showToggle(5, 5), false);
  assert.equal(showToggle(30, 7), true, 'more to show');
  assert.equal(showToggle(30, 30), true, 'can collapse');
  assert.equal(showToggle(7, 7), false);
});
