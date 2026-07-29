import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('worktree services do not import privileged Git or filesystem owners directly', () => {
  const service = fs.readFileSync(
    new URL('../worktree/isolation/worktreeIsolation.impl.js', import.meta.url),
    'utf8',
  );
  const adapter = fs.readFileSync(
    new URL('../worktree/isolation/host/nodeWorktreeIsolationHost.js', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(
    service,
    /node:(?:fs|child_process)|config\/config|git\/workspaceGit|storage\/store/,
  );
  assert.match(service, /nodeWorktreeIsolationHost/);
  assert.match(adapter, /node:fs/);
  assert.match(adapter, /node:child_process/);
  assert.match(adapter, /config\/config/);
  assert.match(adapter, /git\/workspaceGit/);
  assert.match(adapter, /storage\/store/);
});
