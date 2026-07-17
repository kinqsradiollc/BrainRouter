import test from 'node:test';
import assert from 'node:assert/strict';
import { activeEntry, setEntry, dropEntry, shouldProceedGate, reviewBadgeFor, type GateLike } from './reviewWorkspace.js';

const blocked: GateLike = { status: 'blocked', blocked: true, reason: 'x' };
const clean: GateLike = { status: 'clean', blocked: false, reason: 'ok' };

test('review state does NOT leak between workspaces', () => {
  let byWs: Record<string, GateLike> = {};
  byWs = setEntry(byWs, '/A', blocked);
  byWs = setEntry(byWs, '/B', clean);
  // each workspace sees ONLY its own gate
  assert.equal(activeEntry(byWs, '/A')?.status, 'blocked');
  assert.equal(activeEntry(byWs, '/B')?.status, 'clean');
  // switching the active root flips the derived view with no mutation
  const beforeA = activeEntry(byWs, '/A');
  activeEntry(byWs, '/B');
  assert.equal(activeEntry(byWs, '/A'), beforeA, 'reading B did not disturb A');
  // no active root → nothing
  assert.equal(activeEntry(byWs, null), null);
  assert.equal(activeEntry(byWs, '/never-opened'), null);
});

test('setEntry/dropEntry are immutable and workspace-isolated', () => {
  const a = setEntry({}, '/A', blocked);
  const b = setEntry(a, '/B', clean);
  assert.notEqual(a, b);
  assert.equal(a['/B'], undefined, 'adding B did not mutate the A-only map');
  assert.equal(b['/A'], blocked, 'A preserved when B added');
  const dropped = dropEntry(b, '/A');
  assert.equal(dropped['/A'], undefined);
  assert.equal(dropped['/B'], clean, 'dropping A kept B');
  assert.equal(b['/A'], blocked, 'original map untouched by drop');
});

test('shouldProceedGate blocks a gate result whose workspace is no longer active', () => {
  assert.equal(shouldProceedGate('/A', '/A'), true, 'same workspace proceeds');
  assert.equal(shouldProceedGate('/A', '/B'), false, 'A gate cannot act in B');
  assert.equal(shouldProceedGate(null, '/A'), false);
  assert.equal(shouldProceedGate('/A', null), false);
});

test('reviewBadgeFor reflects each workspace gate independently', () => {
  assert.equal(reviewBadgeFor(undefined, 0), null, 'no gate, no changes → quiet');
  assert.equal(reviewBadgeFor(undefined, 3), 'needs-review', 'no gate but changes → needs-review');
  assert.equal(reviewBadgeFor(blocked, 3), 'blocked');
  assert.equal(reviewBadgeFor({ status: 'stale', blocked: true, reason: '' }, 3), 'stale');
  assert.equal(reviewBadgeFor(clean, 3), 'passed');
  assert.equal(reviewBadgeFor(clean, 0), null, 'clean + no changes → quiet');
  assert.equal(reviewBadgeFor(clean, 3, true), 'reviewing', 'running overrides');
  assert.equal(reviewBadgeFor({ status: 'needs-review', blocked: true, reason: '' }, 0), null);
});
