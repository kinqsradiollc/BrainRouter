/**
 * ADR-028 H1 — one create path, and it decides.
 *
 * The property that matters is that the decision happens ONCE. Four call sites
 * each opening a plain PR is how five modules of stack support stayed
 * unreachable; the fix is not "stack more", it is "choose in one place".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { routePullRequest, describeRoute, resolveStackingMode } from '../review/prRouter.js';
import type { StackCapability } from '../review/stackCapability.js';

const CAPABLE: StackCapability = { available: true, extensionInstalled: true };
const MISSING: StackCapability = {
  available: false, reason: 'The gh-stack extension is not installed.', remediable: true,
};
const phase = (id: string, title: string, dependsOn: string[] = []) => ({ id, title, dependsOn });

test('a chained plan becomes a stack', () => {
  const route = routePullRequest({
    mode: 'auto', capability: CAPABLE,
    phases: [phase('a', 'Schema'), phase('b', 'API', ['a']), phase('c', 'CLI', ['b'])],
  });
  assert.equal(route.kind, 'stack');
  assert.equal((route as unknown as { layers: unknown[] }).layers.length, 3);
});

test('a plan that is NOT a chain opens one pull request, with the reason', () => {
  // Fan-out has no linear order; inventing one blocks layers for a reason no
  // reviewer could act on.
  const route = routePullRequest({
    mode: 'auto', capability: CAPABLE,
    phases: [phase('a', 'Schema'), phase('b', 'API', ['a']), phase('c', 'CLI', ['a'])],
  });
  assert.equal(route.kind, 'single');
  assert.match((route as unknown as { reason: string }).reason, /parallel/);
});

test('`always` cannot force an unstackable plan into a stack', () => {
  // The mode expresses appetite, not the ability to reorder a DAG.
  const route = routePullRequest({
    mode: 'always', capability: CAPABLE,
    phases: [phase('a', 'One'), phase('b', 'Two')],
  });
  assert.equal(route.kind, 'single');
});

test('`never` opts out entirely, and says so', () => {
  const route = routePullRequest({
    mode: 'never', capability: CAPABLE,
    phases: [phase('a', 'Schema'), phase('b', 'API', ['a'])],
  });
  assert.equal(route.kind, 'single');
  assert.match((route as unknown as { reason: string }).reason, /turned off/);
});

test('a repository without the extension opens ordinary PRs — not an error', () => {
  // It is what the repository did yesterday, so it is not worth a warning.
  const route = routePullRequest({
    mode: 'auto', capability: MISSING,
    phases: [phase('a', 'Schema'), phase('b', 'API', ['a'])],
  });
  assert.equal(route.kind, 'single');
  assert.match((route as unknown as { reason: string }).reason, /not installed/);
});

test('unplanned work falls back to inferring seams from the diff', () => {
  const route = routePullRequest({
    mode: 'auto', capability: CAPABLE,
    totalChangedLines: 900,
    groups: [
      { label: 'schema', files: ['a.sql'], changedLines: 300 },
      { label: 'api', files: ['b.ts'], changedLines: 600 },
    ],
  });
  assert.equal(route.kind, 'stack');
});

test('a small unplanned change stays one pull request', () => {
  // A one-file fix is not a stack, and a router that stacks everything is
  // worse than one that stacks nothing.
  const route = routePullRequest({
    mode: 'auto', capability: CAPABLE,
    totalChangedLines: 40,
    groups: [{ label: 'fix', files: ['a.ts'], changedLines: 40 }],
  });
  assert.equal(route.kind, 'single');
});

test('with no signal at all it opens one pull request', () => {
  const route = routePullRequest({ mode: 'auto', capability: CAPABLE });
  assert.equal(route.kind, 'single');
});

test('the route is explained BOTH ways', () => {
  // Someone who expected a stack and got one PR needs the reason more than
  // someone who got what they expected.
  assert.match(describeRoute({ kind: 'single', reason: 'it is 40 lines' }), /Opening one pull request/);
  assert.match(
    describeRoute({ kind: 'stack', layers: [{ phaseId: 'a', title: 'A', position: 1 }], rationale: 'chained' }),
    /1-layer stack/,
  );
});

test('the mode defaults to auto for anything unrecognised', () => {
  // Someone who has never used stacks should not have their first PR silently
  // become one, and a typo in config must not change that.
  assert.equal(resolveStackingMode(undefined), 'auto');
  assert.equal(resolveStackingMode('nonsense'), 'auto');
  assert.equal(resolveStackingMode('always'), 'always');
  assert.equal(resolveStackingMode('never'), 'never');
});
