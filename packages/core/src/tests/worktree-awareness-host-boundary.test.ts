import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sourceExtension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';

test('worktree awareness policy does not launch Git directly', () => {
  const policySource = fs.readFileSync(
    new URL(`../worktree/concurrentWorktrees${sourceExtension}`, import.meta.url),
    'utf8',
  );
  const adapterSource = fs.readFileSync(
    new URL(
      `../worktree/awareness/host/nodeWorktreeAwarenessHost${sourceExtension}`,
      import.meta.url,
    ),
    'utf8',
  );

  assert.doesNotMatch(policySource, /node:child_process|execFileSync/);
  assert.match(policySource, /WorktreeAwarenessHost|nodeWorktreeAwarenessHost/);
  assert.match(adapterSource, /node:child_process/);
  assert.match(adapterSource, /git/);
});
