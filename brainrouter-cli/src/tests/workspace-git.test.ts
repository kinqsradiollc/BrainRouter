import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveWorkspaceGit, findGitRoot, workspaceGitScope } from '../config/workspaceGit.js';

const gitInit = (dir: string): void => {
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'tester'], { cwd: dir });
};
const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-')));

test('workspace == git repo root', () => {
  const repo = tmp(); gitInit(repo);
  const info = resolveWorkspaceGit(repo);
  assert.equal(info.hasGit, true);
  assert.equal(info.gitRoot, repo);
  assert.equal(info.isRepoRoot, true);
  assert.equal(info.isSubdir, false);
  assert.equal(info.repoName, path.basename(repo));
  assert.equal(info.repoRelativePath, '');
});

test('workspace is a subdirectory inside a git repo (monorepo subfolder)', () => {
  const repo = tmp(); gitInit(repo);
  const sub = path.join(repo, 'pkg', 'app'); fs.mkdirSync(sub, { recursive: true });
  const info = resolveWorkspaceGit(sub);
  assert.equal(info.gitRoot, repo, 'git root is the OWNING repo, not the subfolder');
  assert.equal(info.isRepoRoot, false);
  assert.equal(info.isSubdir, true);
  assert.equal(info.repoRelativePath, 'pkg/app');
  assert.equal(info.repoName, path.basename(repo));
});

test('nested cloned repo under a parent repo resolves to ITSELF (closest .git wins)', () => {
  const parent = tmp(); gitInit(parent);
  const nested = path.join(parent, 'openSrc', 'thing'); fs.mkdirSync(nested, { recursive: true }); gitInit(nested);
  const info = resolveWorkspaceGit(nested);
  assert.equal(info.gitRoot, fs.realpathSync(nested), 'nested clone owns itself, not the parent');
  assert.equal(info.isRepoRoot, true);
  assert.equal(info.repoName, 'thing');
});

test('no git repo → hasGit false, names derived from the folder', () => {
  const dir = tmp(); // no git init
  const info = resolveWorkspaceGit(dir);
  assert.equal(info.hasGit, false);
  assert.equal(info.gitRoot, null);
  assert.equal(info.isRepoRoot, false);
  assert.equal(info.repoName, path.basename(dir));
  assert.equal(info.repoRelativePath, '');
});

test('workspaceGitScope: subdir runs at git root with a repo-relative pathspec; root is unrestricted', () => {
  const repo = tmp(); gitInit(repo);
  const sub = path.join(repo, 'pkg', 'app'); fs.mkdirSync(sub, { recursive: true });
  const subScope = workspaceGitScope(resolveWorkspaceGit(sub));
  assert.equal(subScope.cwd, repo, 'git command runs at the owning repo root');
  assert.deepEqual(subScope.pathspec, ['pkg/app'], 'restricted to the workspace subpath');
  const rootScope = workspaceGitScope(resolveWorkspaceGit(repo));
  assert.equal(rootScope.cwd, repo);
  assert.deepEqual(rootScope.pathspec, [], 'repo-root workspace = whole repo, no restriction');
});

test('findGitRoot returns null outside any repo', () => {
  assert.equal(findGitRoot(tmp()), null);
});
