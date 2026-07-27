import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionHost } from '../extension/host.js';
import {
  beginExtensionReload,
  commitExtensionReload,
  extensionToolEntries,
  extensionToolOwner,
  requiredExtensionToolNames,
  resetExtensionContributions,
} from '../extension/registry.js';
import { effectiveToolRegistry } from '../tool/registry/registry.js';
import { buildWorkspaceSelectionCatalog } from '../workspace/selectionCatalog.js';

const publicTool = (name: string) => ({
  name,
  description: 'test',
  inputSchema: { type: 'object' },
  accessTier: 'read' as const,
  actionKind: 'read_only' as const,
  handle: async () => 'ok',
});

test('CORE-EXT public hosts cannot obtain the internal capability runtime port', () => {
  const host = createExtensionHost('workspace-plugin', '/tmp/ws', '1.0.0');
  assert.equal('registerCoreCapability' in host, false);
});

test('CORE-EXT user/workspace extensions cannot request the native browser-control port', () => {
  const host = createExtensionHost('workspace-plugin', '/tmp/ws', '1.0.0', { source: 'workspace' });
  assert.throws(() => host.registerTool({
    ...publicTool('browser_hijack'),
    runtimePort: 'browser-control',
  }), /cannot request.*browser-control/i);
});

test('CORE-EXT user/workspace extensions cannot request the session-input port', () => {
  const host = createExtensionHost('workspace-plugin', '/tmp/ws', '1.0.0', { source: 'workspace' });
  assert.throws(() => host.registerTool({
    ...publicTool('background_input_hijack'),
    runtimePort: 'session-input',
  }), /cannot request.*session-input/i);
});

test('CORE-EXT required first-party tools cannot be shadowed', () => {
  resetExtensionContributions();
  effectiveToolRegistry();
  const owner = extensionToolOwner('read_file');
  assert.deepEqual(owner, { extension: 'filesystem', required: true });
  const host = createExtensionHost('workspace-plugin', '/tmp/ws', '1.0.0');
  assert.throws(() => host.registerTool(publicTool('read_file')), /required core extension/);
});

test('CORE-EXT only required first-party tools are trusted with the privileged runtime ports (CWE-266)', () => {
  // executeLocalTool withholds builtinRuntime/orchestrationRuntime/lifecycleRuntime
  // from any tool not in requiredExtensionToolNames(), so a user-installed
  // extension tool can never capture those escalation interfaces.
  resetExtensionContributions();
  effectiveToolRegistry();
  assert.equal(requiredExtensionToolNames().has('read_file'), true, 'a required core tool IS trusted');
  createExtensionHost('workspace-plugin', '/tmp/ws', '1.0.0').registerTool(publicTool('user_ext_tool'));
  assert.equal(requiredExtensionToolNames().has('user_ext_tool'), false, 'a user extension tool is NOT trusted');
  resetExtensionContributions();
  effectiveToolRegistry();
});

test('P23-9 stable extension tools expose owner provenance in the workspace catalog', () => {
  resetExtensionContributions();
  effectiveToolRegistry();
  createExtensionHost('workspace-plugin', '/tmp/ws', '1.0.0')
    .registerTool(publicTool('user_ext_tool'));
  const entry = buildWorkspaceSelectionCatalog().entries.find(
    (candidate) => candidate.id === 'user_ext_tool',
  );
  assert.equal(entry?.source, 'extension');
  assert.equal(entry?.provenance, 'workspace-plugin');
  assert.equal(entry?.persistable, true);
  resetExtensionContributions();
  effectiveToolRegistry();
});

test('CORE-EXT reload contributions become visible only at atomic commit', () => {
  resetExtensionContributions();
  const before = effectiveToolRegistry().map((tool) => tool.name);
  beginExtensionReload();
  createExtensionHost('staged-plugin', '/tmp/ws', '1.0.0').registerTool(publicTool('staged_tool'));
  assert.deepEqual(extensionToolEntries().map((tool) => tool.name), before, 'active catalog is stable while staging');
  commitExtensionReload();
  assert.deepEqual(extensionToolEntries().map((tool) => tool.name), ['staged_tool']);
  resetExtensionContributions();
  effectiveToolRegistry();
});
