import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('background task policy does not import persistence, identity, or process owners', () => {
  const store = fs.readFileSync(
    new URL('../background/backgroundTaskStore.js', import.meta.url),
    'utf8',
  );
  const reconciliation = fs.readFileSync(
    new URL('../background/backgroundReconcile.js', import.meta.url),
    'utf8',
  );
  const adapter = fs.readFileSync(
    new URL('../background/host/nodeBackgroundTaskHost.js', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(
    `${store}\n${reconciliation}`,
    /node:crypto|storage\/store|process\.(?:pid|kill)/,
  );
  assert.match(store, /nodeBackgroundTaskHost/);
  assert.match(reconciliation, /nodeBackgroundTaskHost/);
  assert.match(adapter, /node:crypto/);
  assert.match(adapter, /storage\/store/);
  assert.match(adapter, /process\.pid/);
  assert.match(adapter, /process\.kill/);
});
