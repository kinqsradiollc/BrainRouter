/**
 * ADR-055 P11 (D6) — a restricted session drops the WHOLE embedded browser
 * (observation as well as navigation), so "cannot browse" is coherent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetCliKnobsCache, setCliKnobOverride } from '../config/config.js';
import { registryBrowserToolNames, registryNetworkToolNames } from '../tool/registry/registry.js';
import { createExtensionHost } from '../extension/host.js';
import { resetExtensionContributions } from '../extension/registry.js';

async function loadBrowserExtensionGlobally(): Promise<void> {
  resetExtensionContributions();
  const url = new URL('../../extensions/browser/index.js', import.meta.url).href;
  const ext = await import(/* @vite-ignore */ url as string);
  await ext.activate(createExtensionHost('browser', '/tmp/browser-restricted', 'test', { source: 'builtin' }));
}

test('registryBrowserToolNames lists every browser-control tool (observation AND navigation)', async () => {
  try {
    await loadBrowserExtensionGlobally();
    const browser = registryBrowserToolNames();
    for (const name of ['browser_snapshot', 'browser_find', 'browser_click', 'browser_navigate', 'browser_screenshot']) {
      assert.ok(browser.has(name), `${name} is a browser tool`);
    }
    // A plain read is not one; navigation is BOTH a network tool and a browser tool.
    assert.ok(!browser.has('read_file'));
    assert.ok(registryNetworkToolNames().has('browser_navigate'));
  } finally {
    resetExtensionContributions();
  }
});

test('a restricted agent lists NO browser_* tool (nav or observe)', async () => {
  _resetCliKnobsCache();
  setCliKnobOverride({ restricted: true } as never);
  try {
    await loadBrowserExtensionGlobally();
    const { Agent } = await import('../agent/agent.js');
    const stubMcp: any = { callTool: async () => ({ content: [] }) };
    const agent: any = new Agent(stubMcp, { provider: 'openai', apiKey: '', model: 'gpt-4o-mini' }, {
      workspaceRoot: '/tmp', launchCwd: '/tmp', sessionKey: 's:restricted-browser', accessMode: 'shell',
    });
    const tools = agent.allowedToolsForAccess() as Set<string>;
    for (const name of registryBrowserToolNames()) {
      assert.ok(!tools.has(name), `restricted session must not list ${name}`);
    }
    assert.ok(tools.has('read_file'), 'ordinary reads remain');
  } finally {
    resetExtensionContributions();
    _resetCliKnobsCache();
  }
});

test('WITHOUT restricted, browser observation tools remain listed at read tier', async () => {
  _resetCliKnobsCache();
  setCliKnobOverride({ restricted: false } as never);
  try {
    await loadBrowserExtensionGlobally();
    const { Agent } = await import('../agent/agent.js');
    const stubMcp: any = { callTool: async () => ({ content: [] }) };
    const agent: any = new Agent(stubMcp, { provider: 'openai', apiKey: '', model: 'gpt-4o-mini' }, {
      workspaceRoot: '/tmp', launchCwd: '/tmp', sessionKey: 's:open-browser', accessMode: 'read',
    });
    const tools = agent.allowedToolsForAccess() as Set<string>;
    assert.ok(tools.has('browser_snapshot'), 'read-tier browser observation is available in a normal read session');
  } finally {
    resetExtensionContributions();
    _resetCliKnobsCache();
  }
});
