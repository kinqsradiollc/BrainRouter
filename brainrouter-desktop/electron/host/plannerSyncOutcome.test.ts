import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountFailureOutcome,
  cycleOutcome,
  isConnectivityFailure,
  localOnlyOutcome,
  organizationOutcome,
  signInOutcome,
  withSince,
} from './plannerSyncOutcome.js';

const AT = '2026-09-14T06:40:00.000Z';

test('a server that is not running is "unreachable", not "sign in"', () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  assert.equal(isConnectivityFailure(refused), true);
  const outcome = accountFailureOutcome(refused, 'http://localhost:3747', AT);
  assert.equal(outcome.blocker?.kind, 'unreachable');
  assert.match(outcome.blocker!.message, /http:\/\/localhost:3747 is not answering/);
  assert.equal(outcome.ok, false);
});

test('a refusal by a running server is an error with the server\'s words, and the other blockers say what to do', () => {
  const refused = accountFailureOutcome(new Error('401 Unauthorized'), 'https://brain.example', AT);
  assert.equal(refused.blocker?.kind, 'error');
  assert.match(refused.blocker!.message, /refused the account check: 401 Unauthorized/);
  assert.equal(isConnectivityFailure(new Error('401 Unauthorized')), false);
  assert.match(signInOutcome(AT).blocker!.message, /Sign in \(Settings → Account\)/);
  assert.match(organizationOutcome(AT).blocker!.message, /Choose an active BrainRouter organization/);
  assert.equal(localOnlyOutcome(AT).blocker?.kind, 'local-only');
});

test('a completed cycle is ok with its counts; an offline cycle is unreachable; notices are carried', () => {
  const ok = cycleOutcome({ pulled: 3, pushed: 2, rejected: [], conflicted: [], offline: false, pulledBlocks: 1, repairNotice: 'Re-sending an item the server had not received (Focus block).' }, 'http://localhost:3747', AT);
  assert.equal(ok.ok, true);
  assert.equal(ok.pushed, 2);
  assert.match(ok.notice ?? '', /Re-sending an item/);
  const off = cycleOutcome({ pulled: 0, pushed: 0, rejected: [], conflicted: [], offline: true, pulledBlocks: 0 }, 'http://localhost:3747', AT);
  assert.equal(off.blocker?.kind, 'unreachable');
});

test('"since" survives repeated identical blockers and resets when the blocker changes', () => {
  const first = withSince(localOnlyOutcome('2026-09-14T06:00:00.000Z'), undefined);
  assert.equal(first.since, '2026-09-14T06:00:00.000Z');
  const later = withSince(localOnlyOutcome(AT), first);
  assert.equal(later.since, '2026-09-14T06:00:00.000Z', 'the first time this blocker was seen');
  const changed = withSince(signInOutcome(AT), later);
  assert.equal(changed.since, AT);
  assert.equal(withSince(cycleOutcome({ pulled: 0, pushed: 0, rejected: [], conflicted: [], offline: false, pulledBlocks: 0 }, 'x', AT), changed).since, undefined);
});
