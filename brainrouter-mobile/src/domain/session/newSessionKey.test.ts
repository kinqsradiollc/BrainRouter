// Unit tests for the new-session key generator — the id a "New chat" mints before
// navigating to the Session screen (which resume-sessions it on the host).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newSessionKey } from './newSessionKey.js';

test('newSessionKey returns a mobile-prefixed key', () => {
  assert.match(newSessionKey(), /^mobile:/);
});

test('consecutive keys are unique even within the same millisecond', () => {
  const keys = new Set(Array.from({ length: 200 }, () => newSessionKey()));
  assert.equal(keys.size, 200, 'no collisions across rapid taps');
});
