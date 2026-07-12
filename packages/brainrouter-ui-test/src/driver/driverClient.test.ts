import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DriverClient } from './driverClient.js';
import { normalizeResult } from '../command/normalize.js';

const FAKE_DRIVER = fileURLToPath(new URL('./fakeDriver.js', import.meta.url));

function client(over: Partial<ConstructorParameters<typeof DriverClient>[0]> = {}) {
  return new DriverClient({ scriptPath: FAKE_DRIVER, nodePath: process.execPath, startTimeoutMs: 10000, ...over });
}

test('start handshake then perform returns the raw driver reply', async () => {
  const c = client();
  try {
    const raw = await c.perform({ kind: 'tap', testID: 'login-submit', screen: 'login' });
    const r = normalizeResult(raw, { command: 'tap' });
    assert.equal(r.ok, true);
    assert.equal(r.command, 'tap');
    assert.equal(r.testID, 'login-submit');
  } finally {
    await c.close();
  }
});

test('a transport error reply rejects the perform', async () => {
  const c = client();
  try {
    await assert.rejects(() => c.perform({ kind: 'tap', testID: '__error__' }), /boom/);
  } finally {
    await c.close();
  }
});

test('an unanswered command rejects on the command timeout', async () => {
  const c = client({ timeoutMs: 400 });
  try {
    await assert.rejects(() => c.perform({ kind: 'tap', testID: '__hang__' }), /timed out/);
  } finally {
    await c.close();
  }
});

test('a malformed reply passes through raw and is caught by the normalizer', async () => {
  const c = client();
  try {
    const raw = await c.perform({ kind: 'tap', testID: '__malformed__' });
    const r = normalizeResult(raw, { command: 'tap', testID: '__malformed__' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'error');
  } finally {
    await c.close();
  }
});

test('close shuts the driver down cleanly', async () => {
  const c = client();
  await c.perform({ kind: 'tap', testID: 'x' });
  await c.close(); // resolves once the child exits
  assert.ok(true);
});
