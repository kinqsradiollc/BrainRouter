import test from 'node:test';
import assert from 'node:assert/strict';
import { commitBlocked, gitActionTag } from './reviewGateUi.js';

test('commitBlocked: blocked gate + changes → buttons disabled', () => {
  assert.equal(commitBlocked({ blocked: true }, 3), true);
});
test('commitBlocked: clean gate → not blocked', () => {
  assert.equal(commitBlocked({ blocked: false }, 3), false);
});
test('commitBlocked: no changes → not blocked even if gate says so', () => {
  assert.equal(commitBlocked({ blocked: true }, 0), false);
  assert.equal(commitBlocked(null, 5), false);
});
test('gitActionTag: a CLEAN gate is "reviewed", NOT "bypassed"', () => {
  assert.equal(gitActionTag({ reviewed: true }), 'reviewed');
});
test('gitActionTag: only an explicit bypass is "bypassed"', () => {
  assert.equal(gitActionTag({ bypass: true }), 'bypassed');
  assert.equal(gitActionTag(undefined), '');
});
