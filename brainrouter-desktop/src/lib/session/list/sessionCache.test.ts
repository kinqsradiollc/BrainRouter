import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionRowsCacheKey } from './sessionCache.js';

test('sessionRowsCacheKey partitions identical session keys by workspace root', () => {
  assert.notEqual(
    sessionRowsCacheKey('/workspace/A', 'new-chat'),
    sessionRowsCacheKey('/workspace/B', 'new-chat'),
  );
  assert.equal(sessionRowsCacheKey('/workspace/A', 'new-chat'), '/workspace/A::new-chat');
});

test('sessionRowsCacheKey keeps unknown-root cache entries isolated', () => {
  assert.equal(sessionRowsCacheKey(null, 'session-1'), 'unknown::session-1');
  assert.equal(sessionRowsCacheKey(undefined, 'session-1'), 'unknown::session-1');
});
