import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sourceExtension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';

test('execution planning does not own process or environment effects', () => {
  const policySource = fs.readFileSync(
    new URL(`../exec/hosts${sourceExtension}`, import.meta.url),
    'utf8',
  );
  const adapterSource = fs.readFileSync(
    new URL(`../exec/host/nodeHostCommandExecutor${sourceExtension}`, import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(policySource, /node:child_process|process\.env|spawnSync/);
  assert.match(policySource, /HostCommandExecutor|nodeHostCommandExecutor/);
  assert.match(adapterSource, /node:child_process/);
  assert.match(adapterSource, /process\.env/);
});
