/**
 * ADR-027 D7 (P5-1) — the session execution root.
 *
 * Two properties carry the weight. The workspace root must survive binding a
 * worktree — that is the entire point of D7, since today entering a worktree
 * means a new window, a new project entry, and a new session. And every path
 * must resolve inside the execution root: a session that LOOKS isolated and is
 * not is worse than no isolation, because the isolation gets trusted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  defaultBinding,
  bindWorktree,
  unbindWorktree,
  isWithinExecutionRoot,
  resolveForExecution,
  planRootCleanup,
  describeExecutionRoot,
  ExecutionRootError,
} from '../session/executionRoot.js';

const WORKSPACE = path.resolve('/repo');
const WORKTREE = path.resolve('/worktrees/feature-x');

const base = () => defaultBinding('sess_1', WORKSPACE);

test('a session with no worktree executes in its workspace', () => {
  const binding = base();
  assert.equal(binding.executionRoot.path, WORKSPACE);
  assert.equal(binding.executionRoot.kind, 'workspace');
  assert.equal(binding.executionRoot.ownedBySession, false);
});

test('binding a worktree leaves the WORKSPACE root untouched', () => {
  // The entire point of D7: the chat, project entry, and window keep belonging
  // to the workspace. Only where commands run changes.
  const bound = bindWorktree(base(), { path: WORKTREE, branch: 'feature-x', createdBySession: true });
  assert.equal(bound.workspaceRoot, WORKSPACE, 'unchanged');
  assert.equal(bound.executionRoot.path, WORKTREE);
  assert.equal(bound.executionRoot.branch, 'feature-x');
  assert.equal(bound.sessionId, 'sess_1', 'the same session, not a new one');
});

test('unbinding returns the session to its workspace', () => {
  const bound = bindWorktree(base(), { path: WORKTREE, createdBySession: true });
  const unbound = unbindWorktree(bound);
  assert.equal(unbound.executionRoot.path, WORKSPACE);
  assert.equal(unbound.executionRoot.kind, 'workspace');
});

test('a relative worktree path is refused', () => {
  assert.throws(
    () => bindWorktree(base(), { path: '../elsewhere', createdBySession: true }),
    ExecutionRootError,
  );
});

test('paths inside the execution root are accepted', () => {
  const bound = bindWorktree(base(), { path: WORKTREE, createdBySession: true });
  assert.ok(isWithinExecutionRoot(bound, 'src/app.ts'));
  assert.ok(isWithinExecutionRoot(bound, './src/../src/app.ts'));
  assert.ok(isWithinExecutionRoot(bound, WORKTREE));
});

test('a sibling directory sharing a prefix is NOT inside', () => {
  // The classic prefix bug: `/worktrees/feature-x-backup` starts with
  // `/worktrees/feature-x`, and treating it as inside grants exactly the access
  // the boundary exists to deny.
  const bound = bindWorktree(base(), { path: WORKTREE, createdBySession: true });
  assert.equal(isWithinExecutionRoot(bound, path.resolve('/worktrees/feature-x-backup/secret')), false);
});

test('traversal out of the root is refused', () => {
  const bound = bindWorktree(base(), { path: WORKTREE, createdBySession: true });
  assert.equal(isWithinExecutionRoot(bound, '../../etc/passwd'), false);
  assert.equal(isWithinExecutionRoot(bound, WORKSPACE), false,
    'even the workspace is outside once a worktree is bound');
});

test('resolveForExecution throws rather than clamping', () => {
  // Silently rewriting the path would make a command that meant one file
  // operate on another — worse than refusing, and far harder to notice.
  const bound = bindWorktree(base(), { path: WORKTREE, createdBySession: true });
  assert.equal(resolveForExecution(bound, 'src/a.ts'), path.join(WORKTREE, 'src/a.ts'));
  assert.throws(() => resolveForExecution(bound, '../../etc/passwd'), (error: Error) => {
    assert.ok(error instanceof ExecutionRootError);
    assert.match(error.message, /escapes this session's execution root/);
    return true;
  });
});

test('a workspace-rooted session still bounds its writes', () => {
  assert.equal(isWithinExecutionRoot(base(), 'src/a.ts'), true);
  assert.equal(isWithinExecutionRoot(base(), '../outside/a.ts'), false);
});

test('cleanup removes ONLY a worktree the session created', () => {
  const ours = bindWorktree(base(), { path: WORKTREE, createdBySession: true });
  assert.equal(planRootCleanup(ours).removeWorktree, WORKTREE);
});

test('a pre-existing worktree is never removed', () => {
  // It is the human's, it outlives the conversation, and the session has no way
  // to know what else depends on it.
  const theirs = bindWorktree(base(), { path: WORKTREE, createdBySession: false });
  const plan = planRootCleanup(theirs);
  assert.equal(plan.removeWorktree, null);
  assert.match(plan.reason, /not ours to remove/);
});

test('a workspace-rooted session cleans up nothing', () => {
  const plan = planRootCleanup(base());
  assert.equal(plan.removeWorktree, null);
  assert.match(plan.reason, /nothing to remove/);
});

test('the description makes clear the session did not move', () => {
  const bound = bindWorktree(base(), { path: WORKTREE, branch: 'feature-x', createdBySession: true });
  const text = describeExecutionRoot(bound);
  assert.match(text, /feature-x/);
  assert.match(text, /stay where they are/, 'the reassurance is the feature');
  assert.match(describeExecutionRoot(base()), /project workspace/);
});
