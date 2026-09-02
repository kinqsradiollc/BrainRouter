import test from 'node:test';
import assert from 'node:assert/strict';
import { concreteRendererBrowserTarget } from './rendererCommandTarget.js';
import type { BrowserState } from './protocol.js';

function state(): BrowserState {
  return {
    version: 1,
    activeTabId: 'tab_active',
    tabs: [],
    closedTabCount: 0,
    surface: { x: 0, y: 0, width: 800, height: 600, visible: true },
    downloads: [{
      id: 'download_1', tabId: 'tab_download', filename: 'report.pdf', url: 'https://example.com/report.pdf',
      savePath: null, receivedBytes: 0, totalBytes: 0, state: 'progressing', startedAt: 1,
    }],
    permissionPrompt: { id: 'permission_1', tabId: 'tab_permission', origin: 'https://example.com', permission: 'camera' },
    dialogPrompt: { id: 'dialog_1', tabId: 'tab_dialog', kind: 'confirm', message: 'Continue?' },
    bookmarks: [],
    capabilities: {
      nativeTabs: true,
      sameVisibleTabAutomation: true,
      downloads: true,
      permissions: true,
      semanticSnapshot: true,
      maxTabs: 50,
    },
  };
}

test('renderer page commands bind to the active tab at IPC acceptance', () => {
  assert.equal(concreteRendererBrowserTarget({ op: 'navigate', url: 'https://example.com' }, state()), 'tab_active');
  assert.equal(concreteRendererBrowserTarget({ op: 'reload' }, state()), 'tab_active');
  assert.equal(concreteRendererBrowserTarget({ op: 'clear-data', dataTypes: ['cache'] }, state()), 'tab_active');
});

test('renderer tab commands preserve their explicit target', () => {
  assert.equal(concreteRendererBrowserTarget({ op: 'select-tab', tabId: 'tab_selected' }, state()), 'tab_selected');
  assert.equal(concreteRendererBrowserTarget({ op: 'close-tab', tabId: 'tab_closed' }, state()), 'tab_closed');
  assert.equal(concreteRendererBrowserTarget({ op: 'reorder-tab', tabId: 'tab_moved', toIndex: 1 }, state()), 'tab_moved');
  assert.equal(concreteRendererBrowserTarget({ op: 'close-tab' }, state()), 'tab_active');
});

test('renderer prompt and download commands bind to the resource-owning tab', () => {
  assert.equal(concreteRendererBrowserTarget({ op: 'respond-permission', promptId: 'permission_1', allow: false }, state()), 'tab_permission');
  assert.equal(concreteRendererBrowserTarget({ op: 'respond-dialog', promptId: 'dialog_1', accept: false }, state()), 'tab_dialog');
  assert.equal(concreteRendererBrowserTarget({ op: 'cancel-download', downloadId: 'download_1' }, state()), 'tab_download');
  assert.equal(concreteRendererBrowserTarget({ op: 'respond-dialog', promptId: 'stale_dialog', accept: false }, state()), 'tab_active');
  assert.equal(concreteRendererBrowserTarget({ op: 'cancel-download', downloadId: 'missing_download' }, state()), 'tab_active');
});

test('renderer global tab-creation and state commands have no existing tab target', () => {
  assert.equal(concreteRendererBrowserTarget({ op: 'state' }, state()), undefined);
  assert.equal(concreteRendererBrowserTarget({ op: 'create-tab', active: true }, state()), undefined);
  assert.equal(concreteRendererBrowserTarget({ op: 'reopen-tab' }, state()), undefined);
});
