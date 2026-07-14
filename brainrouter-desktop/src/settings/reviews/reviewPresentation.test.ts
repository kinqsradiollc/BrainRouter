import test from 'node:test';
import assert from 'node:assert/strict';
import { changeRequestUrl, githubPullRequestUrl, normalizeReviewListResponse, pullRequestReviewTarget, reviewActionAvailability } from './reviewPresentation.js';

test('PR review links use an explicit HTTPS URL accepted by the desktop host', () => {
  assert.equal(githubPullRequestUrl('openai/codex', 42), 'https://github.com/openai/codex/pull/42');
  assert.equal(githubPullRequestUrl('../bad', 42), null);
  assert.equal(githubPullRequestUrl('openai/codex', 0), null);
});

test('review backend response preserves read and run capabilities', () => {
  assert.deepEqual(normalizeReviewListResponse({
    signedIn: true,
    canRun: false,
    reviews: [{ id: 'review-1' }],
  }), {
    signedIn: true,
    canRun: false,
    reviews: [{ id: 'review-1' }],
    error: undefined,
  });
});

test('review backend response rejects malformed list payloads safely', () => {
  assert.deepEqual(normalizeReviewListResponse({ signedIn: true, reviews: 'nope', error: 'forbidden' }), {
    signedIn: true,
    canRun: false,
    reviews: [],
    error: 'forbidden',
  });
});

test('PR review targets support GitHub, GitHub Enterprise, and nested GitLab projects without trusting a mismatched number', () => {
  assert.deepEqual(pullRequestReviewTarget('https://github.com/openai/codex/pull/42', 42), { repo: 'openai/codex', prNumber: 42, forge: 'github' });
  assert.deepEqual(pullRequestReviewTarget('https://github.example.test/acme/service/pull/7/files', 7), { repo: 'acme/service', prNumber: 7, forge: 'github' });
  assert.deepEqual(pullRequestReviewTarget('https://gitlab.com/acme/platform/service/-/merge_requests/9/diffs', 9), { repo: 'acme/platform/service', prNumber: 9, forge: 'gitlab' });
  assert.equal(changeRequestUrl('acme/platform/service', 9, 'gitlab'), 'https://gitlab.com/acme/platform/service/-/merge_requests/9');
  assert.equal(pullRequestReviewTarget('https://github.com/openai/codex/pull/42', 41), null);
  assert.equal(pullRequestReviewTarget('http://github.com/openai/codex/pull/42', 42), null);
  assert.equal(pullRequestReviewTarget('https://github.com/../codex/pull/42', 42), null);
});

test('review capability normalization keeps signed-out, read-only RBAC, and backend errors distinct', () => {
  assert.deepEqual(normalizeReviewListResponse({ signedIn: false, canRun: true }), {
    signedIn: false, canRun: true, reviews: [], error: undefined,
  });
  assert.deepEqual(normalizeReviewListResponse({ signedIn: true, canRun: false, error: 'HTTP 403' }), {
    signedIn: true, canRun: false, reviews: [], error: 'HTTP 403',
  });
});

test('review actions remain visible but disabled with an exact auth or RBAC explanation', () => {
  const target = { repo: 'openai/codex', prNumber: 42, forge: 'github' as const };
  assert.deepEqual(reviewActionAvailability({ loading: false, signedIn: false, canRun: false }, target), {
    enabled: false, help: 'Sign in to BrainRouter to use organization reviews.',
  });
  assert.deepEqual(reviewActionAvailability({ loading: false, signedIn: true, canRun: false }, target), {
    enabled: false, help: 'Your role can view reviews but needs the reviews:run capability to start one.',
  });
  assert.deepEqual(reviewActionAvailability({ loading: false, signedIn: true, canRun: true, error: 'HTTP 503' }, target), {
    enabled: false, help: 'Reviews unavailable: HTTP 503',
  });
  assert.equal(reviewActionAvailability({ loading: false, signedIn: true, canRun: true }, target).enabled, true);
});
