import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserControlCommand, BrowserControlPort, BrowserControlResult } from '../browser/control.js';
import type { ExtensionHost, ExtensionToolDef } from '../extension/host.js';
import { createExtensionHost } from '../extension/host.js';
import { resetExtensionContributions } from '../extension/registry.js';
import { localToolExecutor, localToolSpecsFromExecutors } from '../tool/registry/executors.js';
import { registryToolAllowed } from '../tool/registry/registry.js';
import { resolveToolPolicy } from '../exec/policy/execPolicy.js';

interface Harness {
  tools: Map<string, ExtensionToolDef>;
  host: ExtensionHost;
}

function makeHost(workspaceRoot = '/tmp/browser-extension'): Harness {
  const tools = new Map<string, ExtensionToolDef>();
  return {
    tools,
    host: {
      workspaceRoot,
      version: 'test',
      log: () => {},
      registerTool: (def) => tools.set(def.name, def),
      registerProvider: () => {},
      registerHook: () => {},
      registerPanel: () => {},
    },
  };
}

async function loadExtension(): Promise<{ activate: (host: ExtensionHost) => Promise<void> }> {
  const url = new URL('../../extensions/browser/index.js', import.meta.url).href;
  return import(/* @vite-ignore */ url as string);
}

class FakeBrowserPort implements BrowserControlPort {
  readonly calls: BrowserControlCommand[] = [];
  async request(command: BrowserControlCommand): Promise<BrowserControlResult> {
    this.calls.push(command);
    return { ok: true, kind: command.kind, durationMs: 1, data: { accepted: true } };
  }
}

const READ_TOOLS = [
  'browser_capabilities', 'browser_list_tabs', 'browser_get_state', 'browser_snapshot',
  'browser_screenshot', 'browser_console', 'browser_network', 'browser_downloads',
  'browser_list_screens', 'browser_get_screen', 'browser_find_element', 'browser_assert_visible',
];
const NETWORK_TOOLS = [
  'browser_open_tab', 'browser_navigate', 'browser_back', 'browser_forward',
  'browser_reload', 'browser_stop', 'browser_wait',
];
const COMPUTER_TOOLS = [
  'browser_select_tab', 'browser_close_tab', 'browser_reopen_tab', 'browser_reorder_tab',
  'browser_click', 'browser_double_click', 'browser_tap', 'browser_hover', 'browser_type',
  'browser_press', 'browser_scroll', 'browser_drag', 'browser_select_option', 'browser_check',
  'browser_upload_files', 'browser_set_device', 'browser_download_action', 'browser_dialog', 'browser_permission',
  'browser_run_flow',
];

test('browser extension registers a complete live-browser surface with correct policy metadata', async () => {
  const { tools, host } = makeHost();
  await (await loadExtension()).activate(host);
  const expected = [...READ_TOOLS, ...NETWORK_TOOLS, ...COMPUTER_TOOLS].sort();
  assert.deepEqual([...tools.keys()].sort(), expected);
  for (const name of READ_TOOLS) {
    assert.equal(tools.get(name)?.accessTier, 'read', name);
    assert.equal(tools.get(name)?.actionKind, 'read_only', name);
  }
  for (const name of NETWORK_TOOLS) {
    assert.equal(tools.get(name)?.accessTier, 'read', name);
    assert.equal(tools.get(name)?.actionKind, 'network', name);
    assert.equal(tools.get(name)?.audited, true, name);
  }
  for (const name of COMPUTER_TOOLS) {
    assert.equal(tools.get(name)?.accessTier, 'shell', name);
    assert.equal(tools.get(name)?.actionKind, 'computer', name);
  }
  for (const tool of tools.values()) assert.equal(tool.runtimePort, 'browser-control', tool.name);
});

test('browser tools fail deterministically when invoked without the desktop port', async () => {
  const { tools, host } = makeHost();
  await (await loadExtension()).activate(host);
  const raw = await tools.get('browser_list_tabs')!.handle({}, {});
  const result = JSON.parse(raw);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unavailable');
});

test('browser navigation and interactions dispatch to the injected visible-tab port', async () => {
  const { tools, host } = makeHost();
  await (await loadExtension()).activate(host);
  const port = new FakeBrowserPort();
  const runtime = { browserControlPort: port };

  await tools.get('browser_open_tab')!.handle({ url: 'https://example.com', activate: true }, runtime);
  await tools.get('browser_navigate')!.handle({ url: 'https://example.com/docs', tabId: 'tab_1' }, runtime);
  await tools.get('browser_click')!.handle({ ref: 'ref_7', tabId: 'tab_1' }, runtime);
  await tools.get('browser_type')!.handle({ ref: 'ref_8', text: 'hello', replace: true }, runtime);
  await tools.get('browser_select_option')!.handle({ ref: 'ref_9', values: ['one'] }, runtime);
  await tools.get('browser_upload_files')!.handle({ ref: 'ref_10', files: ['./fixtures/report.pdf', 'images\\photo.png'] }, runtime);

  assert.deepEqual(port.calls, [
    { kind: 'tabs.open', url: 'https://example.com/', activate: true },
    { kind: 'page.navigate', url: 'https://example.com/docs', tabId: 'tab_1' },
    { kind: 'page.click', ref: 'ref_7', tabId: 'tab_1' },
    { kind: 'page.type', ref: 'ref_8', text: 'hello', replace: true },
    { kind: 'page.select', ref: 'ref_9', values: ['one'] },
    { kind: 'page.setFiles', ref: 'ref_10', files: ['fixtures/report.pdf', 'images/photo.png'] },
  ]);
});

test('browser upload schema and core boundary reject paths outside the workspace', async () => {
  const { tools, host } = makeHost();
  await (await loadExtension()).activate(host);
  const upload = tools.get('browser_upload_files')!;
  const schema = upload.inputSchema as { properties?: Record<string, any>; required?: string[] };
  assert.deepEqual(schema.required, ['files']);
  assert.equal(schema.properties?.files?.minItems, 1);
  assert.equal(schema.properties?.files?.maxItems, 20);
  assert.equal(schema.properties?.files?.items?.maxLength, 4096);
  assert.equal(upload.accessTier, 'shell');
  assert.equal(upload.actionKind, 'computer');
  assert.equal(upload.runtimePort, 'browser-control');

  const port = new FakeBrowserPort();
  for (const file of ['../outside.txt', '/tmp/outside.txt', 'C:\\outside.txt']) {
    const raw = await upload.handle({ ref: 'upload', files: [file] }, { browserControlPort: port });
    const result = JSON.parse(raw);
    assert.equal(result.ok, false, file);
    assert.equal(result.error.code, 'permission_denied', file);
  }
  assert.equal(port.calls.length, 0);
});

test('browser extension rejects unsafe navigation before calling the desktop port', async () => {
  const { tools, host } = makeHost();
  await (await loadExtension()).activate(host);
  const port = new FakeBrowserPort();
  const raw = await tools.get('browser_navigate')!.handle({ url: 'file:///etc/passwd' }, { browserControlPort: port });
  const result = JSON.parse(raw);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_request');
  assert.equal(port.calls.length, 0);
});

test('browser runtime port and availability flow through the trusted extension executor', async () => {
  resetExtensionContributions();
  const ext = await loadExtension();
  await ext.activate(createExtensionHost('browser', '/tmp/browser-live', 'test', { source: 'builtin' }));

  const hidden = localToolSpecsFromExecutors({ browserUseAvailable: false }).map((tool) => tool.name);
  assert.equal(hidden.includes('browser_list_tabs'), false);
  const visible = localToolSpecsFromExecutors({ browserUseAvailable: true }).map((tool) => tool.name);
  assert.equal(visible.includes('browser_list_tabs'), true);

  assert.equal(registryToolAllowed('browser_click', 'read'), false);
  assert.equal(registryToolAllowed('browser_click', 'shell'), true);
  assert.equal(resolveToolPolicy('browser_click', 'shell').action, 'computer');
  assert.equal(resolveToolPolicy('browser_click', 'shell').mutating, true);
  assert.equal(registryToolAllowed('browser_upload_files', 'read'), false);
  assert.equal(registryToolAllowed('browser_upload_files', 'shell'), true);
  assert.equal(resolveToolPolicy('browser_upload_files', 'shell').action, 'computer');
  assert.equal(resolveToolPolicy('browser_upload_files', 'shell').mutating, true);
  assert.equal(resolveToolPolicy('browser_navigate', 'read').action, 'network');
  assert.equal(resolveToolPolicy('browser_navigate', 'read').mutating, true, 'navigation is explicitly audited');

  const port = new FakeBrowserPort();
  const output = await localToolExecutor('browser_list_tabs')!.handle({ args: {}, browserControlPort: port });
  assert.equal(JSON.parse(output).ok, true);
  assert.deepEqual(port.calls, [{ kind: 'tabs.list' }]);
  resetExtensionContributions();
});
