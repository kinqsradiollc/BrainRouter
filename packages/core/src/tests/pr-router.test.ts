/**
 * ADR-028 H1/H2 — one create path, and the argv it produces.
 *
 * Two properties. The decision happens ONCE, and it only ever answers "stack"
 * where a stack can actually be published — a checkout the user already made
 * one in, asked for with `cli.stackingMode: always`. The router no longer
 * proposes stacks from plans or diff seams, because nothing could author the
 * layers it would name (A2/A7, retired).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { routePullRequest, resolveStackingMode } from '../review/prRouter.js';
import type { StackCapability } from '../review/stackCapability.js';

const CAPABLE: StackCapability = { available: true, extensionInstalled: true };
const MISSING: StackCapability = {
  available: false, reason: 'The gh-stack extension is not installed.', remediable: true,
};

test('`always` submits through gh stack, and says why', () => {
  // The one route to a stack. The user made the stack; we publish into it.
  const route = routePullRequest({ mode: 'always', capability: CAPABLE });
  assert.equal(route.kind, 'stack');
  assert.match(route.reason, /gh stack/);
});

test('`auto` opens one pull request rather than deciding to stack for you', () => {
  // Someone who has never used stacks should not have their first pull request
  // silently become one — and BrainRouter cannot author the layers anyway.
  const route = routePullRequest({ mode: 'auto', capability: CAPABLE });
  assert.equal(route.kind, 'single');
  assert.match(route.reason, /always/);
});

test('`never` opts out entirely, and says so', () => {
  const route = routePullRequest({ mode: 'never', capability: CAPABLE });
  assert.equal(route.kind, 'single');
  assert.match(route.reason, /turned off/);
});

test('`always` cannot produce a stack where gh stack is unusable', () => {
  // Appetite is not capability: routing to `gh stack submit` on a machine
  // without the extension would turn a working plain-PR path into a failure.
  const route = routePullRequest({ mode: 'always', capability: MISSING });
  assert.equal(route.kind, 'single');
  assert.match(route.reason, /not installed/);
});

test('a repository without the extension opens ordinary PRs — not an error', () => {
  // It is what the repository did yesterday, so it is not worth a warning.
  const route = routePullRequest({ mode: 'auto', capability: MISSING });
  assert.equal(route.kind, 'single');
  assert.match(route.reason, /not installed/);
});

test('the mode defaults to auto for anything unrecognised', () => {
  assert.equal(resolveStackingMode(undefined), 'auto');
  assert.equal(resolveStackingMode('nonsense'), 'auto');
  assert.equal(resolveStackingMode('always'), 'always');
  assert.equal(resolveStackingMode('never'), 'never');
});

test('every single route explains itself', () => {
  // Someone who expected a stack and got one pull request needs the reason more
  // than the person who got what they expected.
  for (const mode of ['auto', 'never'] as const) {
    assert.ok(routePullRequest({ mode, capability: CAPABLE }).reason.length > 0);
  }
  assert.ok(routePullRequest({ mode: 'always', capability: MISSING }).reason.length > 0);
});
