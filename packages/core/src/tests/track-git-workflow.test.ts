import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkItem, ensureProject, getWorkItem } from '../track/trackStore.js';
import {
  branchNameForWorkItem,
  parseGitHubRemote,
  readGitTrackContext,
  startGitWorkForTrackItem,
  type GitRunner,
} from '../track/git/gitWorkflow.js';
import { withTempWorkspace } from './_helpers.js';

test('parseGitHubRemote: supports common GitHub remote URL forms', () => {
  assert.deepEqual(parseGitHubRemote('https://github.com/kinqsradiollc/BrainRouter.git'), {
    owner: 'kinqsradiollc',
    repo: 'BrainRouter',
    slug: 'kinqsradiollc/BrainRouter',
  });
  assert.deepEqual(parseGitHubRemote('git@github.com:openai/codex.git')?.slug, 'openai/codex');
  assert.deepEqual(parseGitHubRemote('ssh://git@github.com/openai/codex.git')?.slug, 'openai/codex');
  assert.equal(parseGitHubRemote('https://gitlab.com/openai/codex.git'), undefined);
});

test('readGitTrackContext: derives branch and GitHub repo from local Git', () => {
  const runner: GitRunner = (args) => {
    if (args.join(' ') === 'rev-parse --show-toplevel') return ok('/repo\n');
    if (args.join(' ') === 'branch --show-current') return ok('main\n');
    if (args.join(' ') === 'remote -v') {
      return ok('origin\tgit@github.com:kinqsradiollc/BrainRouter.git (fetch)\norigin\tgit@github.com:kinqsradiollc/BrainRouter.git (push)\n');
    }
    return fail('unexpected git command');
  };
  assert.deepEqual(readGitTrackContext('/repo/subdir', runner), {
    ok: true,
    hasGit: true,
    root: '/repo',
    currentBranch: 'main',
    remotes: [{ name: 'origin', url: 'git@github.com:kinqsradiollc/BrainRouter.git', githubRepo: 'kinqsradiollc/BrainRouter' }],
    githubRepo: 'kinqsradiollc/BrainRouter',
  });
});

test('branchNameForWorkItem: creates stable Track branch names', () => {
  assert.equal(branchNameForWorkItem({ key: 'BR-42', title: 'From issue to merge, in one app!' }), 'track/br-42-from-issue-to-merge-in-one-app');
});

test('startGitWorkForTrackItem: creates a branch, links it, and advances todo work', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    const item = createWorkItem(ws, { title: 'From issue to merge', status: 'todo' });
    const calls: string[] = [];
    const runner: GitRunner = (args) => {
      calls.push(args.join(' '));
      if (args.join(' ') === 'rev-parse --show-toplevel') return ok(`${ws}\n`);
      if (args.join(' ') === 'branch --show-current') return ok('main\n');
      if (args.join(' ') === 'remote -v') return ok('origin\thttps://github.com/kinqsradiollc/BrainRouter.git (fetch)\n');
      if (args[0] === 'check-ref-format') return ok(`${args.at(-1)}\n`);
      if (args[0] === 'show-ref') return fail('');
      if (args.join(' ') === `checkout -b track/${item.key.toLowerCase()}-from-issue-to-merge`) return ok('');
      return fail(`unexpected git command: ${args.join(' ')}`);
    };

    const result = startGitWorkForTrackItem(ws, item.key, {}, runner);
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.switched, true);
    assert.equal(result.branch, `track/${item.key.toLowerCase()}-from-issue-to-merge`);
    assert.ok(calls.includes(`checkout -b track/${item.key.toLowerCase()}-from-issue-to-merge`));

    const after = getWorkItem(ws, item.key)!;
    assert.equal(after.statusCategory, 'started');
    assert.ok(after.codeLinks.some((link) => link.kind === 'branch' && link.ref === result.branch));
  });
});

function ok(stdout: string): ReturnType<GitRunner> {
  return { ok: true, stdout, stderr: '', status: 0 };
}

function fail(stderr: string): ReturnType<GitRunner> {
  return { ok: false, stdout: '', stderr, status: 1 };
}
