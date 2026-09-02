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
    tabId: 'tab_x_1', expectedRevision: 4, command: { op: 'click', ref: 'br:tab_x_1:4:node_1', target: undefined, x: undefined, y: undefined, button: undefined, modifiers: undefined },
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

// ADR-055 P2 — coordinate targeting maps through to the desktop op.
test('mapAgentBrowserCommand threads {x,y} for click/hover and coords for drag', () => {
  assert.deepEqual(
    mapAgentBrowserCommand({ kind: 'page.click', tabId: 'tab_x_1', x: 120, y: 40 } as BrowserControlCommand),
    { tabId: 'tab_x_1', expectedRevision: undefined, command: { op: 'click', ref: undefined, target: undefined, x: 120, y: 40, button: undefined, modifiers: undefined } },
  );
  assert.deepEqual(
    mapAgentBrowserCommand({ kind: 'page.hover', tabId: 'tab_x_1', x: 5, y: 6 } as BrowserControlCommand),
    { tabId: 'tab_x_1', expectedRevision: undefined, command: { op: 'hover', ref: undefined, target: undefined, x: 5, y: 6 } },
  );
  assert.deepEqual(
    mapAgentBrowserCommand({ kind: 'page.drag', tabId: 'tab_x_1', fromX: 1, fromY: 2, toX: 3, toY: 4 } as BrowserControlCommand),
    { tabId: 'tab_x_1', expectedRevision: undefined, command: { op: 'drag', fromRef: undefined, toRef: undefined, fromX: 1, fromY: 2, toX: 3, toY: 4 } },
  );
});

// ADR-055 P3 — snapshot scope threads to the desktop op.
test('mapAgentBrowserCommand threads snapshot scope', () => {
  assert.deepEqual(
    mapAgentBrowserCommand({ kind: 'page.snapshot', tabId: 'tab_x_1', scope: 'page' } as BrowserControlCommand),
    { tabId: 'tab_x_1', command: { op: 'snapshot', mode: 'semantic', scope: 'page' } },
  );
});

// ADR-055 P4 — page.find threads to the find-nodes op.
test('mapAgentBrowserCommand maps page.find to find-nodes', () => {
  assert.deepEqual(
    mapAgentBrowserCommand({ kind: 'page.find', tabId: 'tab_x_1', query: 'Sign in', by: 'text', limit: 5, scope: 'page' } as BrowserControlCommand),
    { tabId: 'tab_x_1', command: { op: 'find-nodes', query: 'Sign in', by: 'text', limit: 5, scope: 'page' } },
  );
});

// ADR-055 P11 — the agent may dismiss but never ACCEPT a certificate dialog.
test('certificate trust decisions are refused for the agent (accept), allowed to dismiss', async () => {
  const certState = state();
  certState.dialogPrompt = { id: 'dlg_1', tabId: 'tab_x_1', kind: 'certificate', message: 'The certificate for example.com is not trusted.' };

  const rejecting = new FakeManager();
  rejecting.current = certState;
  const accept = await executeAgentBrowserCommand(rejecting, { id: 'cert-accept', command: { kind: 'dialog.respond', action: 'accept' } }, '/tmp/workspace');
  assert.equal(accept.ok, false);
  assert.equal((accept as { error?: { code?: string } }).error?.code, 'permission_denied');
  assert.equal(rejecting.calls.length, 0, 'a refused certificate accept never reaches the manager');

  const dismissing = new FakeManager();
  dismissing.current = certState;
  const dismiss = await executeAgentBrowserCommand(dismissing, { id: 'cert-dismiss', command: { kind: 'dialog.respond', action: 'dismiss' } }, '/tmp/workspace');
  assert.equal(dismiss.ok, true, 'dismissing a certificate dialog is allowed');
  assert.equal(dismissing.calls.length, 1);
});

// ADR-055 P5 — a mutating op returns an action receipt (before/after + observed).
test('a mutating op returns an action receipt reflecting what changed', async () => {
  const manager = new FakeManager();
  manager.current = state();
  // Simulate a navigation: the execute() mutates the live state object in place.
  (manager as unknown as { execute: (r: BrowserCommandRequest) => Promise<BrowserCommandResult> }).execute = async (req) => {
    manager.calls.push(req);
    manager.current = {
      ...manager.current,
      tabs: manager.current.tabs.map((t) => t.id === 'tab_x_1'
        ? { ...t, url: 'https://example.com/next', title: 'Next', revision: t.revision + 1 }
        : t),
    };
    return { ok: true, requestId: req.id, tabId: 'tab_x_1', revision: 9, value: { url: 'https://example.com/next' } };
  };

  const result = await executeAgentBrowserCommand(
    manager,
    { id: 'nav-1', command: { kind: 'page.navigate', url: 'https://example.com/next', tabId: 'tab_x_1' } },
    '/tmp/workspace',
  );
  assert.equal(result.ok, true);
  const data = (result as { data?: Record<string, unknown> }).data as { receipt?: any };
  assert.ok(data.receipt, 'the mutating op carries a receipt');
  assert.equal(data.receipt.before.url, 'https://example.com/');
  assert.equal(data.receipt.after.url, 'https://example.com/next');
  assert.equal(data.receipt.observed.navigated, true);
  assert.equal(data.receipt.observed.titleChanged, true);
  assert.equal(data.receipt.observed.revisionChanged, true);
  assert.equal(data.receipt.observed.tabOpened, false);
});

test('a read-only op carries NO receipt', async () => {
  const manager = new FakeManager();
  const result = await executeAgentBrowserCommand(manager, { id: 'list-r', command: { kind: 'tabs.list' } }, '/tmp/workspace');
  assert.equal(result.ok, true);
  const data = (result as { data?: Record<string, unknown> }).data as { receipt?: unknown };
  assert.equal(data.receipt, undefined);
});

// ADR-055 P6 — browser_wait{human} resolves when the challenge clears (hand-back).
test('a human wait resolves once the tab leaves the verification challenge', async () => {
  const manager = new FakeManager();
  const base = state();
  base.tabs = base.tabs.map((t) => t.id === 'tab_x_1' ? { ...t, humanNeeded: true } : t);
  manager.current = base;
  let reads = 0;
  (manager as unknown as { getState: () => BrowserState }).getState = () => {
    reads += 1;
    // The person clears the challenge after a couple of polls.
    if (reads >= 3) manager.current = { ...base, tabs: base.tabs.map((t) => ({ ...t, humanNeeded: false })) };
    return manager.current;
  };
  const result = await executeAgentBrowserCommand(
    manager,
    { id: 'wait-h', command: { kind: 'page.wait', tabId: 'tab_x_1', human: true, timeoutMs: 5000 } },
    '/tmp/workspace',
  );
  assert.equal(result.ok, true, 'the wait resolves after the challenge clears');
  assert.ok(reads >= 3, 'it polled until the challenge cleared');
});
