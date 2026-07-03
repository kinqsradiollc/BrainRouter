import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionHost } from '../extension/host.js';
import {
  resetExtensionContributions,
  extensionHookHandlers,
  registerExtensionHook,
} from '../extension/registry.js';
import { registryAllowedTools, effectiveToolRegistry } from '../tool/registry/registry.js';
import { localToolExecutor } from '../tool/registry/executors.js';
import { PROVIDER_CATALOG, refreshProviderCatalog } from '../provider/catalog.js';

const readTool = {
  name: 'query_warehouse', description: 'q', inputSchema: { type: 'object' },
  accessTier: 'read' as const, actionKind: 'network' as const, parallelSafe: true,
  handle: async () => 'rows: 3',
};
const writeTool = {
  name: 'run_migration', description: 'm', inputSchema: { type: 'object' },
  accessTier: 'write' as const, actionKind: 'file_edit' as const,
  handle: async () => 'migrated',
};

test('a contributed read tool is exposed in read mode, executes, and is gated by tier', async () => {
  resetExtensionContributions();
  const host = createExtensionHost('warehouse', '/tmp/ws', '1.0.0');
  host.registerTool(readTool);
  host.registerTool(writeTool);

  assert.ok(effectiveToolRegistry().some((t) => t.name === 'query_warehouse'));
  assert.ok(registryAllowedTools('read').has('query_warehouse'), 'read tool visible in read mode');
  assert.ok(!registryAllowedTools('read').has('run_migration'), 'write tool hidden below its tier');
  assert.ok(registryAllowedTools('write').has('run_migration'), 'write tool visible in write mode');

  const exec = localToolExecutor('query_warehouse')!;
  assert.equal(exec.accessTier(), 'read');
  assert.equal(await exec.handle({ args: {}, legacyHandle: async () => 'unused' }), 'rows: 3');
  resetExtensionContributions();
});

test('a contributed provider appears after refresh; a built-in id is NOT overridden', () => {
  resetExtensionContributions();
  const host = createExtensionHost('gw', '/tmp/ws', '1.0.0');
  host.registerProvider({ id: 'acme-gw', label: 'Acme', hint: 'acme gateway', endpoint: 'https://acme/v1', envKey: 'ACME_KEY', local: false, pickerVisible: true } as never);
  host.registerProvider({ id: 'openai', label: 'HIJACK', hint: 'x', endpoint: 'https://x/v1', envKey: 'X', local: false, pickerVisible: true } as never);
  refreshProviderCatalog();

  assert.ok(PROVIDER_CATALOG.some((p) => p.id === 'acme-gw'), 'extension provider visible after refresh');
  const openai = PROVIDER_CATALOG.find((p) => p.id === 'openai');
  assert.ok(openai && openai.label !== 'HIJACK', 'built-in id wins over a colliding extension provider');
  resetExtensionContributions();
  refreshProviderCatalog();
});

test('a pre-tool extension hook returning deny is collected for the deny path', async () => {
  resetExtensionContributions();
  registerExtensionHook({ event: 'pre-tool', match: 'run_command', handle: () => 'deny' }, 'guard');
  registerExtensionHook({ event: 'pre-tool', handle: () => undefined }, 'noop');

  const handlers = extensionHookHandlers('pre-tool');
  assert.equal(handlers.length, 2);
  // the matching handler denies; the noop allows
  assert.equal(await handlers[0].handle({ event: 'pre-tool', tool: 'run_command', workspaceRoot: '/tmp' }), 'deny');
  assert.equal(await handlers[1].handle({ event: 'pre-tool', tool: 'run_command', workspaceRoot: '/tmp' }), undefined);
  // a post-tool query sees none of the pre-tool handlers
  assert.equal(extensionHookHandlers('post-tool').length, 0);
  resetExtensionContributions();
});
