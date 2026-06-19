import test from 'node:test';
import assert from 'node:assert/strict';
import { gitPollRefreshDue, gitRefreshDue, GIT_FOCUS_MIN_GAP_MS, GIT_VISIBLE_POLL_MS } from './gitFreshness.js';

test('gitRefreshDue: never-refreshed fires when visible', () => {
  assert.equal(gitRefreshDue(0, 1000, true), true);
  assert.equal(gitRefreshDue(0, 1000, false), false); // hidden tab never refreshes
});

test('gitRefreshDue: debounces rapid focus bursts', () => {
  const last = 10_000;
  // a focus + its paired visibilitychange a few ms later collapse to one refresh
  assert.equal(gitRefreshDue(last, last + 5, true), false);
  assert.equal(gitRefreshDue(last, last + GIT_FOCUS_MIN_GAP_MS - 1, true), false);
});

test('gitRefreshDue: fires again once the gap has elapsed', () => {
  const last = 10_000;
  assert.equal(gitRefreshDue(last, last + GIT_FOCUS_MIN_GAP_MS, true), true);
  assert.equal(gitRefreshDue(last, last + GIT_FOCUS_MIN_GAP_MS + 5000, true), true);
});

test('gitRefreshDue: hidden never refreshes regardless of elapsed time', () => {
  assert.equal(gitRefreshDue(10_000, 999_999, false), false);
});

test('gitPollRefreshDue: visible polling uses the longer poll interval', () => {
  const last = 20_000;
  assert.equal(gitPollRefreshDue(last, last + GIT_VISIBLE_POLL_MS - 1, true), false);
  assert.equal(gitPollRefreshDue(last, last + GIT_VISIBLE_POLL_MS, true), true);
  assert.equal(gitPollRefreshDue(last, last + GIT_VISIBLE_POLL_MS, false), false);
});
