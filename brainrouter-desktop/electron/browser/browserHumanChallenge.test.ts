import test from 'node:test';
import assert from 'node:assert/strict';
import { humanChallengeReason } from './browserHumanChallenge.js';

test('recognizes top-level human-verification pages without matching normal Google pages', () => {
  assert.equal(
    humanChallengeReason('https://www.google.com/sorry/index?continue=x', 'Google'),
    'Google requested human verification.',
  );
  assert.equal(humanChallengeReason('https://www.google.com/search?q=brainrouter', 'Google Search'), null);
  assert.equal(
    humanChallengeReason('https://example.com/check', 'Verify you are human'),
    'This site requested human verification.',
  );
});

test('does not classify arbitrary challenge-like paths without a verification title', () => {
  assert.equal(humanChallengeReason('https://example.com/challenge/lesson', 'Lesson challenge'), null);
  assert.equal(humanChallengeReason('not-yet-a-url', 'Loading'), null);
});
