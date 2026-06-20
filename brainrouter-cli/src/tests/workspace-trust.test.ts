import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sandbox the global home BEFORE importing the store (it reads BRAINROUTER_HOME).
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trust-home-')));
process.env.BRAINROUTER_HOME = HOME;

const { isWorkspaceTrusted, trustWorkspace, untrustWorkspace, listTrustedWorkspaces } =
  await import('@kinqs/brainrouter-core/dist/workspace/workspaceTrust.js');

const tmpWs = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trust-ws-')));

test('a fresh workspace is NOT trusted', () => {
  assert.equal(isWorkspaceTrusted(tmpWs()), false);
});

test('trustWorkspace persists; isWorkspaceTrusted sees it; survives a re-read', () => {
  const ws = tmpWs();
  trustWorkspace(ws);
  assert.equal(isWorkspaceTrusted(ws), true);
  // persisted to the global home file (shared with the CLI/main), not in-memory
  assert.ok(fs.existsSync(path.join(HOME, 'trusted-workspaces.json')));
  assert.ok(listTrustedWorkspaces().includes(ws));
});

test('trust is idempotent (no duplicates) and untrust removes it', () => {
  const ws = tmpWs();
  trustWorkspace(ws); trustWorkspace(ws);
  assert.equal(listTrustedWorkspaces().filter((r) => r === ws).length, 1);
  untrustWorkspace(ws);
  assert.equal(isWorkspaceTrusted(ws), false);
});

test('trust comparison is path-normalized (trailing slash / .. segments)', () => {
  const ws = tmpWs();
  trustWorkspace(ws);
  assert.equal(isWorkspaceTrusted(`${ws}/`), true);
  assert.equal(isWorkspaceTrusted(path.join(ws, 'sub', '..')), true);
});
