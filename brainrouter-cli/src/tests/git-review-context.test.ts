import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectReviewDiff } from '../runtime/platform/gitContext.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

test('collectReviewDiff includes complete tracked and untracked file diffs', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'brainrouter-review-diff-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  git(workspace, 'init');
  writeFileSync(join(workspace, 'tracked.ts'), 'export const value = 1;\n');
  git(workspace, 'add', 'tracked.ts');
  git(workspace, '-c', 'user.name=BrainRouter Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'test fixture');

  writeFileSync(join(workspace, 'tracked.ts'), 'export const value = 2;\n');
  writeFileSync(join(workspace, 'untracked.ts'), 'export const newValue = 3;\n');
  const review = await collectReviewDiff(workspace);

  assert.equal(review.error, undefined);
  assert.equal(review.truncated, false);
  assert.equal(review.hasChanges, true);
  assert.deepEqual(review.files.sort(), ['tracked.ts', 'untracked.ts']);
  assert.match(review.diff, /diff --git a\/tracked\.ts b\/tracked\.ts/);
  assert.match(review.diff, /diff --git a\/untracked\.ts b\/untracked\.ts/);
  assert.match(review.diff, /export const newValue = 3/);
});

test('collectReviewDiff reports a non-repository instead of returning clean', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'brainrouter-review-no-git-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const review = await collectReviewDiff(workspace);
  assert.equal(review.hasChanges, false);
  assert.ok(review.error);
});

test('collectReviewDiff supports an unborn repository without duplicating a staged file', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'brainrouter-review-unborn-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  git(workspace, 'init');
  writeFileSync(join(workspace, 'first.ts'), 'export const first = true;\n');
  git(workspace, 'add', 'first.ts');

  const review = await collectReviewDiff(workspace);
  assert.equal(review.error, undefined);
  assert.deepEqual(review.files, ['first.ts']);
  assert.equal(review.diff.match(/diff --git a\/first\.ts b\/first\.ts/g)?.length, 1);
});
