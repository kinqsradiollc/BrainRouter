import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('background shell policy does not import process, filesystem, or state-path owners', () => {
  const service = fs.readFileSync(
    new URL('../exec/runtime/backgroundShell.js', import.meta.url),
    'utf8',
  );
  const adapter = fs.readFileSync(
    new URL('../exec/runtime/backgroundShell/host/nodeBackgroundShellHost.js', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(
    service,
    /node:(?:fs|child_process|crypto|path)|storage\/store|process\.(?:kill|once)/,
  );
  assert.match(service, /nodeBackgroundShellHost/);
  assert.match(adapter, /node:fs/);
  assert.match(adapter, /node:child_process/);
  assert.match(adapter, /node:crypto/);
  assert.match(adapter, /storage\/store/);
});
