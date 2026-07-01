import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitService, GitService } from '../git/service.js';
import { findGitRoot, gitHeadSha, resolveWorkspaceGit, workspaceGitScope } from '../git/workspaceGit.js';
import { gitChurnSignal } from '../git/gitChurn.js';

test('GitService is a stateless facade — delegates to the read-only git helpers', () => {
  const svc = createGitService();
  assert.ok(svc instanceof GitService);

  const dir = process.cwd();
  // Parity whether git is present or not (CI-robust).
  const call = (fn: () => unknown): string => {
    try { return JSON.stringify(fn()) ?? 'undefined'; } catch { return 'THREW'; }
  };
  assert.equal(call(() => svc.findRoot(dir)), call(() => findGitRoot(dir)));
  assert.equal(call(() => svc.headSha(dir)), call(() => gitHeadSha(dir)));

  const root = findGitRoot(dir);
  if (root) {
    assert.deepEqual(svc.resolveWorkspace(root), resolveWorkspaceGit(root));
    const info = resolveWorkspaceGit(root);
    assert.deepEqual(svc.scope(info), workspaceGitScope(info));
    assert.equal(call(() => svc.churnSignal(root, 'package.json')), call(() => gitChurnSignal(root, 'package.json')));
  }
});
