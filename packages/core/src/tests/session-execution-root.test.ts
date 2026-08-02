/**
 * ADR-027 D7 (P5-1) — session execution root, decoupled from the window.
 *
 * The interesting property is not the bookkeeping, it is that the execution
 * root is the base for every path authorization the session makes. These tests
 * pin the cases where getting it wrong authorizes a write against the wrong
 * directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  windowRootedSession,
  worktreeRootedSession,
  retargetWindow,
  rebaseSession,
  isPinnedAwayFromWindow,
  authorizationRoot,
  describeExecutionRoot,
  ExecutionRootError,
} from '../session/executionRoot.js';

const WS = '/Users/x/repo';
const WT = '/Users/x/worktrees/feature';

test('a plain session runs where its window points', () => {
  const s = windowRootedSession(WS);
  assert.equal(s.executionRoot, WS);
  assert.equal(s.windowWorkspace, WS);
  assert.equal(isPinnedAwayFromWindow(s), false);
  assert.equal(s.worktreeOf, undefined);
});

test('a relative root is refused rather than resolved against the process cwd', () => {
  // The cwd belongs to whoever launched the app, not to the session. Every
  // path check built on it would answer the wrong question.
  for (const bad of ['relative/path', './here', '', '   ']) {
    assert.throws(() => windowRootedSession(bad), ExecutionRootError, `for ${JSON.stringify(bad)}`);
  }
});

test('a worktree session records where it came from', () => {
  const s = worktreeRootedSession({ windowWorkspace: WS, worktreePath: WT });
  assert.equal(s.executionRoot, WT);
  assert.equal(s.windowWorkspace, WS);
  assert.equal(s.worktreeOf, WS);
  assert.equal(isPinnedAwayFromWindow(s), true);
  assert.match(describeExecutionRoot(s), /worktree of/);
});

test('a "worktree" equal to the workspace is not labelled as one', () => {
  // Claiming isolation that does not exist is worse than showing a bare path.
  const s = worktreeRootedSession({ windowWorkspace: WS, worktreePath: WS });
  assert.equal(s.worktreeOf, undefined);
  assert.equal(isPinnedAwayFromWindow(s), false);
});

test('moving the window does NOT drag a pinned session along', () => {
  // This is the entire point of the decoupling.
  const pinned = worktreeRootedSession({ windowWorkspace: WS, worktreePath: WT });
  const moved = retargetWindow(pinned, '/Users/x/other');
  assert.equal(moved.executionRoot, WT, 'the pinned session keeps running in its worktree');
  assert.equal(moved.windowWorkspace, '/Users/x/other');
});

test('an unpinned session still follows its window', () => {
  // The pre-existing behaviour has to survive, or every ordinary session breaks.
  const plain = windowRootedSession(WS);
  const moved = retargetWindow(plain, '/Users/x/other');
  assert.equal(moved.executionRoot, '/Users/x/other');
  assert.equal(moved.windowWorkspace, '/Users/x/other');
});

test('rebasing is refused while a tool call is in flight', () => {
  // A path authorized against the old root would be applied against the new.
  const s = windowRootedSession(WS);
  assert.throws(
    () => rebaseSession({ session: s, nextExecutionRoot: WT, inFlightToolCalls: 1 }),
    /in flight/,
  );
});

test('an unknown in-flight count is refused, not assumed to be zero', () => {
  const s = windowRootedSession(WS);
  for (const bad of [-1, 1.5, Number.NaN, undefined as unknown as number]) {
    assert.throws(
      () => rebaseSession({ session: s, nextExecutionRoot: WT, inFlightToolCalls: bad }),
      ExecutionRootError,
      `for ${String(bad)}`,
    );
  }
});

test('rebasing with nothing in flight moves the root and records the origin', () => {
  const s = windowRootedSession(WS);
  const rebased = rebaseSession({ session: s, nextExecutionRoot: WT, inFlightToolCalls: 0 });
  assert.equal(rebased.executionRoot, WT);
  assert.equal(rebased.windowWorkspace, WS, 'the window is untouched');
  assert.equal(rebased.worktreeOf, WS);
});

test('rebasing back to the window clears the worktree label', () => {
  const pinned = worktreeRootedSession({ windowWorkspace: WS, worktreePath: WT });
  const back = rebaseSession({ session: pinned, nextExecutionRoot: WS, inFlightToolCalls: 0 });
  assert.equal(back.worktreeOf, undefined);
  assert.equal(isPinnedAwayFromWindow(back), false);
});

test('authorization resolves against the EXECUTION root, never the window', () => {
  // The two were the same value before this module existed, so reaching for
  // windowWorkspace is the habit most likely to survive the change — and it
  // would authorize paths against a directory the session does not run in.
  const pinned = worktreeRootedSession({ windowWorkspace: WS, worktreePath: WT });
  assert.equal(authorizationRoot(pinned), WT);
  assert.notEqual(authorizationRoot(pinned), pinned.windowWorkspace);
});

test('roots are normalized so equality comparisons are meaningful', () => {
  const s = windowRootedSession('/Users/x/repo/../repo/./');
  assert.equal(s.executionRoot, '/Users/x/repo/');
  const t = worktreeRootedSession({ windowWorkspace: '/a/b/../b', worktreePath: '/a/b' });
  assert.equal(isPinnedAwayFromWindow(t), false, 'normalized equal paths are the same root');
});
