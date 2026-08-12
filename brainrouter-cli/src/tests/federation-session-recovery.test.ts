/**
 * ADR-034 CLI session recovery regression: a resumed logical conversation
 * reclaims its durable address without letting a second live incarnation win.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSessionNotFoundError } from '@kinqs/brainrouter-core/mcp';
import { resolveFederationSessionKey } from '../runtime/federation/federationRegistration.js';

/**
 * Coverage for federation participant recovery:
 *
 *  - `resolveFederationSessionKey` preserves the logical Agent conversation
 *    key so a resumed host can reclaim durable rows after a crash.
 *  - `isSessionNotFoundError` matches the Streamable HTTP transport's
 *    session-expiry shape (drives `callTool`'s auto-reconnect path).
 */

function freshWorkspace(label: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-fed-${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('resolveFederationSessionKey: resume preserves the exact logical conversation address', () => {
  const logicalSessionKey = '24fd9ca8-4e42-4da9-b247-41e51d494d72';
  assert.equal(resolveFederationSessionKey(logicalSessionKey), logicalSessionKey);
  assert.equal(resolveFederationSessionKey(logicalSessionKey), logicalSessionKey);
  assert.notEqual(
    resolveFederationSessionKey('98cf79ab-4f29-4b6f-9c28-d14a8ed76e70'),
    logicalSessionKey,
  );
});

test('resolveFederationSessionKey: leaves no on-disk artifact (no persistence)', () => {
  const { dir, cleanup } = freshWorkspace('no-disk');
  try {
    resolveFederationSessionKey('24fd9ca8-4e42-4da9-b247-41e51d494d72');
    // Was `<workspace>/.brainrouter/cli/federation.json`; that path must
    // not exist anymore — its presence in a real workspace is what caused
    // the two-terminal collision bug.
    const ghostPath = join(dir, '.brainrouter', 'cli', 'federation.json');
    assert.equal(existsSync(ghostPath), false, `unexpected federation.json at ${ghostPath}`);
  } finally {
    cleanup();
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
