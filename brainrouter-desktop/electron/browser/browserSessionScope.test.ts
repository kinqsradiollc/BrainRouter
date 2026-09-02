/**
 * CHAT-BROWSER-ISOLATION regression tests: a clean chat must never inherit
 * another chat's visible tab or browser observations.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedBrowserState, scopedBrowserTarget } from './browserSessionScope.js';
import type { BrowserState } from './protocol.js';

function state(): BrowserState {
  return {
    version: 1,
    activeTabId: 'tab-a',
    tabs: [
      { id: 'tab-a', title: 'Previous chat', url: 'https://example.test/a', faviconUrl: null, loading: false, canGoBack: false, canGoForward: false, crashed: false, audible: false, muted: false, revision: 1, zoomFactor: 1, lastAccessedAt: 1 },
      { id: 'tab-b', title: 'Current chat', url: 'https://example.test/b', faviconUrl: null, loading: false, canGoBack: false, canGoForward: false, crashed: false, audible: false, muted: false, revision: 2, zoomFactor: 1, lastAccessedAt: 2 },
    ],
    closedTabCount: 0,
    surface: { x: 0, y: 0, width: 100, height: 100, visible: true },
    downloads: [],
    permissionPrompt: null,
    dialogPrompt: null,
    bookmarks: [],
    capabilities: { nativeTabs: true, sameVisibleTabAutomation: true, downloads: true, permissions: true, semanticSnapshot: true, maxTabs: 20 },
  };
}

test('a new chat sees no tabs owned by a previous chat', () => {
  const scoped = scopedBrowserState(state(), new Set());
  assert.deepEqual(scoped.tabs, []);
  assert.equal(scoped.activeTabId, '');
});

test('implicit navigation selects only the current chat owned tab', () => {
  const owned = new Set(['tab-b']);
  assert.equal(scopedBrowserTarget({ kind: 'page.reload' }, state(), owned), 'tab-b');
  assert.equal(scopedBrowserTarget({ kind: 'page.reload', tabId: 'tab-a' }, state(), owned), undefined);
});
