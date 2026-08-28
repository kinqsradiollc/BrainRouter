/**
 * ADR-050 P3/P4 — the permission posture mappers, the InteractionPort→onPermission
 * bridge, the catalog's declared transports, and the engine's transport selection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { claudePermissionArgs } from '../agent/session/claudeStreamJson.js';
import { codexApprovalParams } from '../agent/session/codexAppServer.js';
import { acpModeId } from '../agent/session/acpStdio.js';
import { bridgeInteractionToPermission } from '../agent/session/permissionBridge.js';
import { resolveEngineTransport } from '../agent/transport/externalAgentEngine.js';
import { getAgentAdapter } from '../agent/adapters/catalog.js';

test('posture mappers: explicit modes map per protocol; undefined is a no-op (agent default)', () => {
  assert.deepEqual(claudePermissionArgs('full-access'), ['--permission-mode', 'bypassPermissions']);
  assert.deepEqual(claudePermissionArgs('auto-edit'), ['--permission-mode', 'acceptEdits']);
  assert.deepEqual(claudePermissionArgs(undefined), []);
  assert.deepEqual(codexApprovalParams('full-access'), { approval_policy: 'never', sandbox: 'danger-full-access' });
  assert.deepEqual(codexApprovalParams(undefined), {});
  assert.equal(acpModeId('auto-edit'), 'acceptEdits');
  assert.equal(acpModeId(undefined), undefined);
});

test('the catalog declares each agent\'s structured transport', () => {
  assert.equal(getAgentAdapter('claude-code')?.sessionTransport, 'claude-stream-json');
  assert.equal(getAgentAdapter('codex')?.sessionTransport, 'codex-app-server');
  assert.equal(getAgentAdapter('gemini-cli')?.sessionTransport, 'acp-stdio');
  assert.deepEqual(getAgentAdapter('gemini-cli')?.sessionArgs, ['--experimental-acp']);
  // opencode speaks HTTP, not a stdio session protocol → no declared transport.
  assert.equal(getAgentAdapter('opencode')?.sessionTransport, undefined);
});

test('resolveEngineTransport: off ⇒ one-shot; on ⇒ the declared transport; undeclared ⇒ one-shot', () => {
  assert.equal(resolveEngineTransport('claude-code', false), 'stdio-oneshot');
  assert.equal(resolveEngineTransport('claude-code', true), 'claude-stream-json');
  assert.equal(resolveEngineTransport('codex', true), 'codex-app-server');
  assert.equal(resolveEngineTransport('gemini-cli', true), 'acp-stdio');
  assert.equal(resolveEngineTransport('opencode', true), 'stdio-oneshot');
  assert.equal(resolveEngineTransport('a-custom-hosted-agent', true), 'stdio-oneshot');
});

test('permission bridge: confirmExplicit is lossless (dismissed ≠ approved); a command is dangerous', async () => {
  const seen: Array<{ dangerous?: boolean; tool?: string }> = [];
  const port = {
    confirm: async () => true,
    confirmExplicit: async (p: any) => { seen.push({ dangerous: p.dangerous, tool: p.tool }); return p.title.includes('yes') ? 'approved' as const : p.title.includes('drop') ? 'dismissed' as const : 'declined' as const; },
    choice: async () => null,
  };
  const onPermission = bridgeInteractionToPermission(port);
  assert.equal(await onPermission({ requestId: '1', kind: 'command', title: 'yes run it' }), 'approved');
  assert.equal(await onPermission({ requestId: '2', kind: 'file-edit', title: 'no' }), 'declined');
  assert.equal(await onPermission({ requestId: '3', kind: 'other', title: 'drop it' }), 'declined'); // dismissed → declined (fail-closed)
  assert.equal(seen[0]!.dangerous, true, 'a command request is flagged dangerous');
  assert.equal(seen[1]!.dangerous, false);
});

test('permission bridge falls back to confirm() when confirmExplicit is absent', async () => {
  let asked = 0;
  const port = { confirm: async () => { asked += 1; return false; }, choice: async () => null };
  const onPermission = bridgeInteractionToPermission(port);
  assert.equal(await onPermission({ requestId: '1', kind: 'command', title: 'x' }), 'declined');
  assert.equal(asked, 1);
});
