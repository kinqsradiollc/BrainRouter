import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveWorkspaceGit, findGitRoot, workspaceGitScope } from '../git/workspaceGit.js';
import { repoTag } from '../track/git/repoIdentity.js';

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

test('remote origin → repoIdentity + repoTag populated, independent of http/ssh form (ADR-015)', () => {
  const repo = tmp(); gitInit(repo);
  spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:kinqsradiollc/BrainRouter.git'], { cwd: repo });
  const info = resolveWorkspaceGit(repo);
  assert.equal(info.remoteUrl, 'git@github.com:kinqsradiollc/BrainRouter.git');
  assert.equal(info.repoIdentity, 'github.com/kinqsradiollc/brainrouter');
  assert.equal(info.repoTag.length, 16);
  assert.equal(info.repoTag, repoTag('https://github.com/kinqsradiollc/BrainRouter'),
    'same tag whether the local remote is ssh or https');
});

test('git repo with no remote → remoteUrl null, identity + tag empty', () => {
  const repo = tmp(); gitInit(repo);
  const info = resolveWorkspaceGit(repo);
  assert.equal(info.hasGit, true);
  assert.equal(info.remoteUrl, null);
  assert.equal(info.repoIdentity, '');
  assert.equal(info.repoTag, '');
});

test('no git repo → remote fields null/empty too', () => {
  const info = resolveWorkspaceGit(tmp());
  assert.equal(info.remoteUrl, null);
  assert.equal(info.repoIdentity, '');
  assert.equal(info.repoTag, '');
});
