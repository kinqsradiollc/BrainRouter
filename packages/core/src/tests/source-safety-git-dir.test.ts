/**
 * `.git` is a credential directory, not just metadata.
 *
 * `.git/config` carries remote URLs, and a repository cloned with a token embeds
 * it: `https://x-access-token:ghp_…@github.com/owner/repo`. So the one directory
 * present in every repository we review is also one that routinely holds a live
 * credential — alongside `.git/credentials` and anything a hook script left.
 *
 * Reads in the review path are already bounded to the diff's file inventory and
 * opened `O_NOFOLLOW`, so this is defence in depth rather than a live hole. It
 * matters anyway: a denylist naming `.aws` and `.ssh` while omitting `.git`
 * reads as an oversight, and the inventory will not be the only caller this
 * predicate ever has.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSensitiveReviewSourcePath } from '../review/sourceSafety.js';

test('git internals are treated as sensitive wherever they appear', () => {
  for (const target of [
    '.git/config',
    '.git/credentials',
    '.git/HEAD',
    'nested/repo/.git/config',
  ]) {
    assert.equal(isSensitiveReviewSourcePath(target), true, `${target} must be refused`);
  }
});

test('the existing credential directories still hold', () => {
  for (const target of ['.ssh/id_rsa', '.aws/credentials', '.kube/config', '.gnupg/secring.gpg']) {
    assert.equal(isSensitiveReviewSourcePath(target), true, `${target} must be refused`);
  }
});

test('ordinary source is untouched, including names that merely contain "git"', () => {
  // The check is on a path SEGMENT, so a file about git is not a git internal —
  // refusing `.gitignore` or `src/github.ts` would quietly shrink review
  // coverage while looking like security.
  for (const target of [
    'src/index.ts',
    '.gitignore',
    '.github/workflows/ci.yml',
    'src/github.ts',
    'docs/git-workflow.md',
  ]) {
    assert.equal(isSensitiveReviewSourcePath(target), false, `${target} must stay reviewable`);
  }
});
