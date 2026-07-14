import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrackSyncAuthFailure, resolveTrackSyncAvailability } from './syncAvailability.js';

test('Track sync uses the signed-in account OAuth and detected git remote without a PAT', () => {
  assert.deepEqual(resolveTrackSyncAvailability({
    repo: null,
    hasToken: false,
    tokenSource: null,
    detectedRepo: 'openai/codex',
    account: { signedIn: true, connected: true, login: 'octocat' },
  }), {
    provider: 'github',
    configured: true,
    repo: 'openai/codex',
    source: 'BrainRouter account · octocat',
    accountManaged: true,
  });
});

test('Track sync preserves an explicit connector/PAT target as a supported fallback', () => {
  assert.deepEqual(resolveTrackSyncAvailability({
    repo: 'acme/private',
    hasToken: true,
    tokenSource: 'connector-env',
    detectedRepo: 'acme/other',
    account: { signedIn: true, connected: false },
  }), {
    provider: 'github',
    configured: true,
    repo: 'acme/private',
    source: 'connector-env',
    accountManaged: false,
  });
});

test('Track sync remains unavailable when neither account OAuth nor a local credential can operate', () => {
  assert.deepEqual(resolveTrackSyncAvailability({
    repo: null,
    hasToken: false,
    tokenSource: null,
    detectedRepo: 'acme/repo',
    account: { signedIn: true, connected: false },
  }), {
    provider: 'github',
    configured: false,
    repo: 'acme/repo',
    source: null,
    accountManaged: false,
  });
});

test('Track sync treats a connected GitLab account and detected nested project as configured', () => {
  assert.deepEqual(resolveTrackSyncAvailability({
    provider: 'gitlab',
    repo: null,
    hasToken: false,
    tokenSource: null,
    detectedRepo: 'platform/group/service',
    account: { signedIn: true, connected: true, login: 'ada' },
  }), {
    provider: 'gitlab',
    configured: true,
    repo: 'platform/group/service',
    source: 'BrainRouter account · ada',
    accountManaged: true,
  });
});

test('Track sync distinguishes an expired account authorization from a clean empty result', () => {
  assert.equal(isTrackSyncAuthFailure(['list failed (HTTP 401)']), true);
  assert.equal(isTrackSyncAuthFailure(['GitHub is not connected.']), true);
  assert.equal(isTrackSyncAuthFailure(['conflict on title']), false);
  assert.equal(isTrackSyncAuthFailure([]), false);
});
