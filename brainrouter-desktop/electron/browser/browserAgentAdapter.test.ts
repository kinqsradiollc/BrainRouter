import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserControlCommand } from '@kinqs/brainrouter-core/browser';
import type { BrowserCommandRequest, BrowserCommandResult, BrowserState } from './protocol.js';
import { executeAgentBrowserCommand, mapAgentBrowserCommand, type BrowserManagerPort } from './browserAgentAdapter.js';

function state(): BrowserState {
  return {
    version: 1,
    activeTabId: 'tab_x_1',
    tabs: [{ id: 'tab_x_1', url: 'https://example.com/', title: 'Example', faviconUrl: null, loading: false, canGoBack: true, canGoForward: false, crashed: false, audible: false, muted: false, zoomFactor: 1, revision: 4, lastAccessedAt: 1 }],
    closedTabCount: 0,
    surface: { x: 0, y: 0, width: 800, height: 600, visible: true },
    downloads: [], permissionPrompt: null, dialogPrompt: null,
    capabilities: { nativeTabs: true, sameVisibleTabAutomation: true, downloads: true, permissions: true, semanticSnapshot: true, maxTabs: 50 },
  };
}

class FakeManager implements BrowserManagerPort {
  readonly calls: BrowserCommandRequest[] = [];
  current = state();
  next: BrowserCommandResult = { ok: true, requestId: 'x', tabId: 'tab_x_1', revision: 4, value: { accepted: true } };
  getState(): BrowserState { return this.current; }
  async execute(request: BrowserCommandRequest): Promise<BrowserCommandResult> { this.calls.push(request); return { ...this.next, requestId: request.id } as BrowserCommandResult; }
}

test('agent browser command mapping targets exact tab/revision and never exposes arbitrary eval', () => {
  assert.deepEqual(mapAgentBrowserCommand({ kind: 'tabs.open', url: 'https://example.com/', activate: true }), { command: { op: 'create-tab', url: 'https://example.com/', active: true } });
  assert.deepEqual(mapAgentBrowserCommand({ kind: 'tabs.open', url: 'https://example.com/' }), { command: { op: 'create-tab', url: 'https://example.com/', active: false } });
  assert.deepEqual(mapAgentBrowserCommand({ kind: 'page.click', tabId: 'tab_x_1', ref: 'br:tab_x_1:4:node_1', pageRevision: 4 }), {
    tabId: 'tab_x_1', expectedRevision: 4, command: { op: 'click', ref: 'br:tab_x_1:4:node_1', target: undefined, button: undefined, modifiers: undefined },
  });
  assert.deepEqual(mapAgentBrowserCommand({ kind: 'page.setFiles', tabId: 'tab_x_1', testId: 'avatar', pageRevision: 4, files: ['fixtures/avatar.png'] }), {
    tabId: 'tab_x_1', expectedRevision: 4, command: { op: 'set-files', ref: undefined, target: 'avatar', files: ['fixtures/avatar.png'] },
  });
  assert.throws(() => mapAgentBrowserCommand({ kind: 'page.navigate', url: 'javascript:alert(1)' } as BrowserControlCommand));
});

test('file upload maps workspace-relative files and never returns resolved local paths', async () => {
  const manager = new FakeManager();
  manager.next = { ok: true, requestId: 'x', tabId: 'tab_x_1', revision: 5, value: { accepted: true, fileCount: 1, paths: ['/private/workspace/secret.txt'] } };
  const result = await executeAgentBrowserCommand(manager, {
    id: 'upload-1',
    command: { kind: 'page.setFiles', tabId: 'tab_x_1', testId: 'upload', pageRevision: 4, files: ['fixtures/upload.txt'] },
  }, '/tmp/workspace');
  assert.deepEqual((result as { data: unknown }).data, { accepted: true, fileCount: 1 });
  assert.deepEqual(manager.calls[0]?.command, { op: 'set-files', ref: undefined, target: 'upload', files: ['fixtures/upload.txt'] });
});

test('inactive tab creation returns the newly opened tab identity, not the user active tab', async () => {
  const manager = new FakeManager();
  manager.next = {
    ok: true,
    requestId: 'x',
    tabId: 'tab_x_1',
    revision: 4,
    value: {
      id: 'tab_agent_2',
      revision: 1,
      title: 'Background agent tab',
      url: 'https://example.com/research',
    },
  };
  const result = await executeAgentBrowserCommand(manager, {
    id: 'open-background',
    command: {
      kind: 'tabs.open',
      url: 'https://example.com/research',
      activate: false,
    },
  }, '/tmp/workspace');
  assert.equal(result.ok, true);
  assert.equal(result.tabId, 'tab_agent_2');
  assert.equal(result.pageRevision, 1);
});

test('download observations omit absolute save paths while keeping actionable ids', async () => {
  const manager = new FakeManager();
  manager.next = { ok: true, requestId: 'x', tabId: 'tab_x_1', revision: 4, value: [{ id: 'download_1', tabId: 'tab_x_1', filename: 'report.pdf', url: 'https://example.com/report.pdf', savePath: '/Users/alice/Downloads/report.pdf', receivedBytes: 10, totalBytes: 10, state: 'completed', startedAt: 1 }] };
  const result = await executeAgentBrowserCommand(manager, { id: 'downloads-1', command: { kind: 'page.downloads' } }, '/tmp/workspace');
  const [download] = (result as { data: Array<Record<string, unknown>> }).data;
  assert.equal(download.id, 'download_1');
  assert.equal(download.saved, true);
  assert.equal(download.savePath, undefined);
});

test('tabs/state results use the core browser-control shape', async () => {
  const manager = new FakeManager();
  const result = await executeAgentBrowserCommand(manager, { id: 'list-1', command: { kind: 'tabs.list' } }, '/tmp/workspace');
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'tabs.list');
  assert.deepEqual((result as { data: { tabs: unknown[] } }).data.tabs, [{ id: 'tab_x_1', title: 'Example', url: 'https://example.com/', active: true, loading: false, canGoBack: true, canGoForward: false, crashed: false, pageRevision: 4, zoomFactor: 1 }]);
  assert.equal(manager.calls.length, 0, 'state reads do not enqueue a page command');
});

test('manager failures map to bounded core error codes', async () => {
  const manager = new FakeManager();
  manager.next = { ok: false, requestId: 'x', code: 'STALE_PAGE', error: 'Take a new snapshot', tabId: 'tab_x_1', revision: 7 };
  const result = await executeAgentBrowserCommand(manager, { id: 'click-1', command: { kind: 'page.click', tabId: 'tab_x_1', ref: 'br:tab_x_1:4:node_1', pageRevision: 4 } }, '/tmp/workspace');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'stale_ref');
});

test('agent screenshots are saved as workspace artifacts and base64 is not returned', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-artifact-'));
  try {
    const manager = new FakeManager();
    manager.next = { ok: true, requestId: 'x', tabId: 'tab_x_1', revision: 4, value: { dataUrl: `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`, width: 100, height: 60, fullPage: false } };
    const result = await executeAgentBrowserCommand(manager, { id: 'shot-1', command: { kind: 'page.screenshot' } }, root);
    assert.equal(result.ok, true);
    const data = (result as { data: { path: string; dataUrl?: string } }).data;
    assert.equal(data.dataUrl, undefined);
    assert.equal(fs.readFileSync(path.join(root, data.path), 'utf8'), 'png-bytes');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function screenshotManager(): FakeManager {
  const manager = new FakeManager();
  manager.next = {
    ok: true,
    requestId: 'x',
    tabId: 'tab_x_1',
    revision: 4,
    value: { dataUrl: `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`, width: 100, height: 60, fullPage: false },
  };
  return manager;
}

async function takeScreenshot(root: string) {
  return executeAgentBrowserCommand(screenshotManager(), { id: 'secure-shot', command: { kind: 'page.screenshot' } }, root);
}

test('screenshot artifacts use the canonical workspace when its caller path is a symlink', { skip: process.platform === 'win32' }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-artifact-canonical-'));
  const workspace = path.join(parent, 'workspace');
  const alias = path.join(parent, 'workspace-alias');
  fs.mkdirSync(workspace);
  fs.symlinkSync(workspace, alias, 'dir');
  try {
    const result = await takeScreenshot(alias);
    assert.equal(result.ok, true);
    const artifact = (result as { data: { path: string } }).data.path;
    assert.match(artifact, /^\.brainrouter\/browser\/screenshots\//);
    assert.equal(fs.readFileSync(path.join(workspace, artifact), 'utf8'), 'png-bytes');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('screenshot artifacts reject symlinked storage ancestors without writing outside the workspace', { skip: process.platform === 'win32' }, async () => {
  for (const symlinkAt of ['.brainrouter', '.brainrouter/browser', '.brainrouter/browser/screenshots']) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-artifact-link-'));
    const root = path.join(parent, 'workspace');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    const link = path.join(root, ...symlinkAt.split('/'));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link, 'dir');
    try {
      const result = await takeScreenshot(root);
      assert.equal(result.ok, false, symlinkAt);
      if (!result.ok) {
        assert.equal(result.error.code, 'permission_denied', symlinkAt);
        assert.equal(result.error.message.includes(root), false, symlinkAt);
        assert.equal(result.error.message.includes(outside), false, symlinkAt);
      }
      assert.deepEqual(fs.readdirSync(outside), [], symlinkAt);
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  }
});

test('screenshot artifact filesystem failures never expose the requested workspace path', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-artifact-missing-'));
  const missing = path.join(parent, 'private-customer-workspace');
  try {
    const result = await takeScreenshot(missing);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'internal');
      assert.equal(result.error.message.includes(missing), false);
      assert.equal(result.error.message.includes('private-customer-workspace'), false);
    }
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('screenshot artifact target creation is exclusive and no-follow without leaking paths', { skip: process.platform === 'win32' }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-artifact-target-'));
  const root = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside.png');
  fs.mkdirSync(root);
  fs.writeFileSync(outside, 'outside-original');

  const originalOpen = fs.openSync;
  let observedFlags = 0;
  fs.openSync = ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    observedFlags = Number(flags);
    fs.symlinkSync(outside, target);
    return originalOpen(target, flags, mode);
  }) as typeof fs.openSync;
  try {
    const result = await takeScreenshot(root);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'permission_denied');
      assert.equal(result.error.message.includes(root), false);
      assert.equal(result.error.message.includes(outside), false);
    }
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-original');
    assert.ok((observedFlags & fs.constants.O_EXCL) !== 0, 'target creation must be exclusive');
    if (typeof fs.constants.O_NOFOLLOW === 'number' && fs.constants.O_NOFOLLOW !== 0) {
      assert.ok((observedFlags & fs.constants.O_NOFOLLOW) !== 0, 'platform no-follow flag must be enabled');
    }
  } finally {
    fs.openSync = originalOpen;
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
