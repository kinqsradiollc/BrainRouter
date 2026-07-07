import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepoUrl, repoTag, sameRepo, matchLinkedRepo } from '../track/git/repoIdentity.js';

test('normalizeRepoUrl: https, scp-ssh, and ssh:// forms of the same repo collapse', () => {
  const want = 'github.com/kinqsradiollc/brainrouter';
  assert.equal(normalizeRepoUrl('https://github.com/kinqsradiollc/BrainRouter.git'), want);
  assert.equal(normalizeRepoUrl('git@github.com:kinqsradiollc/BrainRouter.git'), want);
  assert.equal(normalizeRepoUrl('ssh://git@github.com/kinqsradiollc/BrainRouter'), want);
  assert.equal(normalizeRepoUrl('github.com/kinqsradiollc/BrainRouter/'), want);
});

test('normalizeRepoUrl: keeps nested groups (gitlab subgroups)', () => {
  assert.equal(normalizeRepoUrl('git@gitlab.com:group/sub/repo.git'), 'gitlab.com/group/sub/repo');
  assert.equal(normalizeRepoUrl('https://gitlab.com/group/sub/repo'), 'gitlab.com/group/sub/repo');
});

test('normalizeRepoUrl: rejects non-remotes', () => {
  assert.equal(normalizeRepoUrl(''), '');
  assert.equal(normalizeRepoUrl('   '), '');
  assert.equal(normalizeRepoUrl('not a url'), '');
  assert.equal(normalizeRepoUrl('https://github.com/owner'), ''); // owner only, no repo
});

test('repoTag: stable 16-char, equal across remote shapes, empty on junk', () => {
  const a = repoTag('https://github.com/kinqsradiollc/BrainRouter.git');
  const b = repoTag('git@github.com:kinqsradiollc/BrainRouter');
  assert.equal(a.length, 16);
  assert.equal(a, b);
  assert.equal(repoTag('nonsense'), '');
});

test('sameRepo: matches across http/ssh, distinguishes different repos + junk', () => {
  assert.equal(sameRepo('https://github.com/o/r.git', 'git@github.com:o/r'), true);
  assert.equal(sameRepo('https://github.com/o/r', 'https://github.com/o/r2'), false);
  assert.equal(sameRepo('', 'https://github.com/o/r'), false);
});

test('matchLinkedRepo: matches a workspace remote against linked repos (cloud + connector shapes)', () => {
  const cloud = [{ repoUrl: 'https://github.com/kinqsradiollc/BrainRouter.git' }, { repoUrl: 'https://github.com/o/other' }];
  const hit = matchLinkedRepo('git@github.com:kinqsradiollc/BrainRouter.git', cloud);
  assert.equal(hit?.repoUrl, 'https://github.com/kinqsradiollc/BrainRouter.git', 'ssh workspace remote matches the https linked url');

  const connector = [{ url: 'https://github.com/o/a' }, { url: 'https://github.com/o/b' }];
  assert.equal(matchLinkedRepo('https://github.com/o/b', connector)?.url, 'https://github.com/o/b');

  assert.equal(matchLinkedRepo('https://github.com/o/none', cloud), null, 'no match → null');
  assert.equal(matchLinkedRepo('', cloud), null, 'empty remote → null');
});
