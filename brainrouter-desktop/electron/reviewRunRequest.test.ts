import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopReviewRunRequest } from './reviewRunRequest.js';

test('desktop review host never infers deep mode from acceptance or omitted mode', () => {
  const implicit = desktopReviewRunRequest({
    repo: 'acme/widgets',
    prNumber: 7,
    lens: 'security',
    deepReviewAccepted: true,
  });

  assert.deepEqual(implicit, {
    ok: true,
    body: {
      repo: 'acme/widgets',
      prNumber: 7,
      lens: 'security',
      forge: 'github',
      mode: 'diff',
    },
  });
});

test('desktop review host requires acceptance and sends the displayed preset', () => {
  const denied = desktopReviewRunRequest({
    repo: 'acme/widgets',
    prNumber: 7,
    lens: 'security',
    mode: 'deep',
  });
  assert.equal(denied.ok, false);

  const accepted = desktopReviewRunRequest({
    repo: 'acme/widgets',
    prNumber: 7,
    lens: 'security',
    mode: 'deep',
    deepReviewAccepted: true,
  });
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.body.mode, 'deep');
  assert.equal(accepted.body.deepReview?.telemetryThresholds.maxRepositoryFiles, 20_000);
  assert.equal(accepted.body.deepReview?.budgets.maxDurationMs, 20 * 60_000);
});

test('desktop review host rejects invalid modes and deep pentest substitution', () => {
  assert.equal(desktopReviewRunRequest({
    repo: 'acme/widgets',
    prNumber: 7,
    lens: 'code',
    mode: 'automatic',
  }).ok, false);
  assert.equal(desktopReviewRunRequest({
    repo: 'acme/widgets',
    prNumber: 7,
    lens: 'pentest',
    mode: 'deep',
    deepReviewAccepted: true,
  }).ok, false);
});
