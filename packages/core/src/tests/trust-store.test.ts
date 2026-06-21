import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the per-user trust file at a throwaway home BEFORE importing the store.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'br-trust-'));
process.env.BRAINROUTER_HOME = TMP_HOME;

const { isWorkspaceTrusted, trustWorkspace, revokeWorkspace, listTrusted, trustFilePath, canonicalWorkspace } =
  await import('../trust/trust.js');

test('trust round-trip: untrusted by default → trust → revoke', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'br-ws-'));
  assert.equal(isWorkspaceTrusted(ws), false, 'untrusted by default');
  trustWorkspace(ws, 'tester');
  assert.equal(isWorkspaceTrusted(ws), true, 'trusted after trustWorkspace');
  assert.equal(listTrusted().some((t) => t.workspaceRoot === canonicalWorkspace(ws)), true);
  assert.equal(revokeWorkspace(ws), true, 'revoke removes it');
  assert.equal(isWorkspaceTrusted(ws), false, 'untrusted after revoke');
  assert.equal(revokeWorkspace(ws), false, 'revoking an untrusted ws returns false');
});

test('trust file is PER-USER (under BRAINROUTER_HOME), not inside the workspace', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'br-ws-'));
  trustWorkspace(ws);
  assert.ok(trustFilePath().startsWith(TMP_HOME), 'trust.json lives under the home, not the workspace');
  assert.equal(fs.existsSync(path.join(ws, 'trust.json')), false, 'no trust file written into the workspace');
});

test('trust matches a workspace regardless of trailing slash', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'br-ws-'));
  trustWorkspace(ws + '/');
  assert.equal(isWorkspaceTrusted(ws), true, 'trailing slash canonicalizes to the same entry');
});
