import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSessionNotFoundError } from '../runtime/mcpClient.js';
import { resolveFederationSessionKey } from '../runtime/federationRegistration.js';

/**
 * Coverage for the three fixes shipped on top of FED-S2:
 *
 *  - `resolveFederationSessionKey` is stable across calls for one
 *    workspace (reuse the on-disk key instead of minting a fresh UUID
 *    every CLI start, which used to stack ghost rows in the registry
 *    until the 5-min sweeper ran).
 *  - `isSessionNotFoundError` matches the Streamable HTTP transport's
 *    session-expiry shape (drives `callTool`'s auto-reconnect path).
 */

function freshWorkspace(label: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-fed-${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('resolveFederationSessionKey: stable across calls for one workspace', () => {
  const { dir, cleanup } = freshWorkspace('stable');
  try {
    const first = resolveFederationSessionKey(dir);
    assert.match(first, /^[0-9a-f-]{36}$/, 'first call mints a uuid');
    const second = resolveFederationSessionKey(dir);
    assert.equal(second, first, 'second call must return the persisted key');
    const third = resolveFederationSessionKey(dir);
    assert.equal(third, first);
  } finally {
    cleanup();
  }
});

test('resolveFederationSessionKey: different workspaces get different keys', () => {
  const a = freshWorkspace('wsA');
  const b = freshWorkspace('wsB');
  try {
    const keyA = resolveFederationSessionKey(a.dir);
    const keyB = resolveFederationSessionKey(b.dir);
    assert.notEqual(keyA, keyB);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('isSessionNotFoundError: matches the Streamable HTTP brain-restart shape', () => {
  // Exact shape the user observed in the bug report.
  const raw = new Error(
    'Streamable HTTP error: Error POSTing to endpoint: {"error":"Session not found. Send a POST without mcp-session-id to initialise."}',
  );
  assert.equal(isSessionNotFoundError(raw), true);
});

test('isSessionNotFoundError: matches the bare server-side message', () => {
  assert.equal(
    isSessionNotFoundError(new Error('Session not found. Send a POST without mcp-session-id to initialise.')),
    true,
  );
});

test('isSessionNotFoundError: tolerates non-Error throws (string, undefined)', () => {
  assert.equal(isSessionNotFoundError('Session not found'), true);
  assert.equal(isSessionNotFoundError(undefined), false);
  assert.equal(isSessionNotFoundError(null), false);
});

test('isSessionNotFoundError: does NOT match unrelated MCP errors', () => {
  assert.equal(isSessionNotFoundError(new Error('MCP tool "foo" timed out after 60000ms')), false);
  assert.equal(isSessionNotFoundError(new Error('not connected')), false);
  assert.equal(isSessionNotFoundError(new Error('rate limited')), false);
});
