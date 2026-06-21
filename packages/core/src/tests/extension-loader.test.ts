import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Per-user trust + enable state under a throwaway home.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'br-extload-home-'));
process.env.BRAINROUTER_HOME = TMP_HOME;

const { loadExtensions } = await import('../extension/loader.js');
const { trustWorkspace } = await import('../trust/trust.js');
const { setExtensionEnabled } = await import('../extension/extensionStore.js');

/** Create a workspace-tier extension whose index.js body is `body`. */
function mkWorkspaceExt(name: string, body: string): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'br-extload-ws-'));
  const dir = path.join(ws, '.brainrouter', 'extensions', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify({ name, version: '1.0.0' }), 'utf-8');
  fs.writeFileSync(path.join(dir, 'index.js'), body, 'utf-8');
  return ws;
}

const TOOL_EXT = `export const activate = (host) => {
  host.registerTool({ name: '${'ext_tool'}', description: 'd', inputSchema: { type: 'object' },
    accessTier: 'read', actionKind: 'read_only', handle: async () => 'ok' });
};`;

test('a workspace extension activates only when the workspace is TRUSTED', async () => {
  const ws = mkWorkspaceExt('w-tool', TOOL_EXT);

  const untrusted = await loadExtensions(ws);
  assert.equal(untrusted.activated.length, 0, 'untrusted workspace: not activated');
  assert.equal(untrusted.skippedUntrusted.length, 1, 'untrusted workspace: listed as skipped');

  trustWorkspace(ws);
  const trusted = await loadExtensions(ws);
  assert.deepEqual(trusted.activated, ['w-tool'], 'trusted workspace: activated');
  assert.equal(trusted.skippedUntrusted.length, 0);
});

test('a throwing activate is fault-isolated (recorded as an error, never fatal)', async () => {
  const ws = mkWorkspaceExt('w-throw', `export const activate = () => { throw new Error('boom'); };`);
  trustWorkspace(ws);
  const r = await loadExtensions(ws);
  assert.equal(r.activated.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /boom/);
});

test('a module without activate is rejected, not crashed', async () => {
  const ws = mkWorkspaceExt('w-noact', `export const notActivate = () => {};`);
  trustWorkspace(ws);
  const r = await loadExtensions(ws);
  assert.equal(r.activated.length, 0);
  assert.match(r.errors[0].error, /does not export activate/);
});

test('a disabled extension is skipped even in a trusted workspace', async () => {
  const ws = mkWorkspaceExt('w-disabled', TOOL_EXT);
  trustWorkspace(ws);
  setExtensionEnabled('w-disabled', false);
  const r = await loadExtensions(ws);
  assert.deepEqual(r.skippedDisabled, ['w-disabled']);
  assert.equal(r.activated.length, 0);
  setExtensionEnabled('w-disabled', true); // restore
});
