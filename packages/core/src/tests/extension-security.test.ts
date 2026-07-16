import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionHost } from '../extension/host.js';
import {
  beginExtensionReload,
  commitExtensionReload,
  extensionToolEntries,
  extensionToolOwner,
  resetExtensionContributions,
} from '../extension/registry.js';
import { effectiveToolRegistry } from '../tool/registry/registry.js';

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

test('CORE-EXT required first-party tools cannot be shadowed', () => {
  resetExtensionContributions();
  effectiveToolRegistry();
  const owner = extensionToolOwner('read_file');
  assert.deepEqual(owner, { extension: 'filesystem', required: true });
  const host = createExtensionHost('workspace-plugin', '/tmp/ws', '1.0.0');
  assert.throws(() => host.registerTool(publicTool('read_file')), /required core extension/);
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
