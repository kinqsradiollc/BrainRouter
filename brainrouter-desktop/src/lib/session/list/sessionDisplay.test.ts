import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateTitleKeys } from './sessionDisplay.js';

test('no duplicates → empty set (rows render plainly)', () => {
  const dupes = duplicateTitleKeys([
    { sessionKey: 'a', firstUserMessage: 'fix the reranker' },
    { sessionKey: 'b', firstUserMessage: 'release 0.4.15' },
  ]);
  assert.equal(dupes.size, 0);
});

test('identical prompts are flagged for disambiguation', () => {
  const dupes = duplicateTitleKeys([
    { sessionKey: 'a', firstUserMessage: 'fix the bug' },
    { sessionKey: 'b', firstUserMessage: 'fix the bug' },
    { sessionKey: 'c', firstUserMessage: 'something else' },
  ]);
  assert.deepEqual([...dupes].sort(), ['a', 'b']);
});

test('whitespace-only differences still count as the same title', () => {
  const dupes = duplicateTitleKeys([
    { sessionKey: 'a', firstUserMessage: '  deploy  ' },
    { sessionKey: 'b', firstUserMessage: 'deploy' },
  ]);
  assert.equal(dupes.size, 2);
});

test('sessions with no firstUserMessage fall back to the (unique) sessionKey', () => {
  const dupes = duplicateTitleKeys([
    { sessionKey: 'sess:1' },
    { sessionKey: 'sess:2' },
  ]);
  assert.equal(dupes.size, 0, 'distinct keys are not duplicates');
});
