import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_BLANK_URL, MAX_BROWSER_TABS } from './protocol.js';
import {
  activeTab,
  createTabModel,
  reduceTabModel,
  type BrowserTabModel,
} from './tabState.js';

function createTabs(count: number): BrowserTabModel {
  let model = createTabModel();
  for (let index = 1; index < count; index += 1) {
    model = reduceTabModel(model, {
      type: 'create',
      url: `https://example.com/${index}`,
      now: index,
    });
  }
  return model;
}

test('starts with one usable blank tab and normalizes created tab addresses', () => {
  let model = createTabModel();
  assert.equal(model.tabs.length, 1);
  assert.equal(activeTab(model).url, BROWSER_BLANK_URL);
  assert.equal(activeTab(model).revision, 1);

  model = reduceTabModel(model, { type: 'create', url: 'example.com/docs', now: 10 });
  assert.equal(activeTab(model).url, 'https://example.com/docs');
  assert.equal(activeTab(model).lastAccessedAt, 10);

  model = reduceTabModel(model, { type: 'create', url: 'javascript:alert(1)', now: 11 });
  assert.match(activeTab(model).url, /^https:\/\/www\.google\.com\/search\?/);
  assert.doesNotMatch(activeTab(model).url, /^javascript:/i);
});

test('create, select, reorder, close and reopen preserve stable tab metadata', () => {
  let model = createTabModel();
  const firstId = activeTab(model).id;
  model = reduceTabModel(model, { type: 'create', url: 'https://one.example', now: 1 });
  const secondId = activeTab(model).id;
  model = reduceTabModel(model, { type: 'create', url: 'https://two.example', now: 2 });
  const thirdId = activeTab(model).id;

  model = reduceTabModel(model, { type: 'select', tabId: firstId, now: 3 });
  assert.equal(model.activeTabId, firstId);
  assert.equal(activeTab(model).lastAccessedAt, 3);

  model = reduceTabModel(model, { type: 'reorder', tabId: thirdId, toIndex: 0 });
  assert.deepEqual(model.tabs.map((tab) => tab.id), [thirdId, firstId, secondId]);
  assert.equal(model.activeTabId, firstId, 'reordering does not change selection');

  model = reduceTabModel(model, { type: 'close', tabId: firstId, now: 4 });
  assert.equal(model.activeTabId, secondId, 'closing active tab selects its right-hand neighbour');
  assert.equal(model.recentlyClosed.at(-1)?.tab.id, firstId);

  model = reduceTabModel(model, { type: 'reopen', now: 5 });
  assert.equal(model.activeTabId, firstId);
  assert.equal(activeTab(model).id, firstId, 'reopen restores the same logical tab id');
  assert.equal(activeTab(model).revision, 2, 'new WebContents invalidates old element refs');
  assert.deepEqual(model.tabs.map((tab) => tab.id), [thirdId, firstId, secondId]);
});

test('closing the last tab creates a fresh blank tab with a monotonic id', () => {
  let model = createTabModel();
  const closedId = activeTab(model).id;
  model = reduceTabModel(model, { type: 'close', now: 20 });

  assert.equal(model.tabs.length, 1);
  assert.equal(activeTab(model).url, BROWSER_BLANK_URL);
  assert.notEqual(activeTab(model).id, closedId);
  assert.equal(model.recentlyClosed.at(-1)?.tab.id, closedId);
});

test('popup creation records its opener and does not leak opener page state', () => {
  let model = createTabModel();
  const openerId = activeTab(model).id;
  model = reduceTabModel(model, {
    type: 'metadata',
    tabId: openerId,
    title: 'Opener title',
    faviconUrl: 'https://example.com/opener.ico',
    audible: true,
  });
  model = reduceTabModel(model, {
    type: 'popup',
    openerTabId: openerId,
    url: 'https://popup.example/path',
    now: 30,
  });

  const popup = activeTab(model);
  assert.equal(popup.openerTabId, openerId);
  assert.equal(popup.url, 'https://popup.example/path');
  assert.equal(popup.title, 'New tab');
  assert.equal(popup.faviconUrl, null);
  assert.equal(popup.audible, false);
  assert.equal(model.tabs.find((tab) => tab.id === openerId)?.title, 'Opener title');
});

test('history metadata and page revisions change only for the intended tab', () => {
  let model = createTabs(2);
  const [background, foreground] = model.tabs;
  model = reduceTabModel(model, {
    type: 'history',
    tabId: foreground.id,
    canGoBack: true,
    canGoForward: false,
    entryCount: 4,
    currentIndex: 3,
  });
  model = reduceTabModel(model, {
    type: 'navigation-committed',
    tabId: foreground.id,
    url: 'https://example.com/committed',
    title: 'Committed',
    now: 44,
  });

  const updated = model.tabs.find((tab) => tab.id === foreground.id)!;
  const untouched = model.tabs.find((tab) => tab.id === background.id)!;
  assert.equal(updated.historyEntryCount, 4);
  assert.equal(updated.historyIndex, 3);
  assert.equal(updated.canGoBack, true);
  assert.equal(updated.revision, foreground.revision + 1);
  assert.equal(updated.url, 'https://example.com/committed');
  assert.deepEqual(untouched, background);
});

test('crashes invalidate page refs and recovery starts a clean load', () => {
  let model = createTabModel();
  const tabId = activeTab(model).id;
  model = reduceTabModel(model, { type: 'crashed', tabId });
  assert.equal(activeTab(model).crashed, true);
  assert.equal(activeTab(model).loading, false);
  assert.equal(activeTab(model).revision, 2);

  model = reduceTabModel(model, { type: 'recover', tabId, now: 55 });
  assert.equal(activeTab(model).crashed, false);
  assert.equal(activeTab(model).loading, true);
  assert.equal(activeTab(model).revision, 3);
  assert.equal(activeTab(model).lastAccessedAt, 55);
});

test('restore removes duplicate ids, keeps safe metadata and selects a valid tab', () => {
  const model = createTabModel({
    activeTabId: 'tab_8',
    tabs: [
      { id: 'tab_7', url: 'example.com/a', title: 'A', zoomFactor: 1.25 },
      { id: 'tab_8', url: 'https://example.com/b', title: 'B', muted: true },
      { id: 'tab_8', url: 'https://attacker.invalid', title: 'duplicate' },
    ],
  });

  assert.deepEqual(model.tabs.map((tab) => tab.id), ['tab_7', 'tab_8']);
  assert.equal(model.activeTabId, 'tab_8');
  assert.equal(model.tabs[0].url, 'https://example.com/a');
  assert.equal(model.tabs[0].zoomFactor, 1.25);
  assert.equal(model.tabs[1].muted, true);

  const replaced = reduceTabModel(model, {
    type: 'restore',
    tabs: [{ id: 'restored', url: 'https://restore.example' }],
    activeTabId: 'missing',
  });
  assert.equal(replaced.tabs.length, 1);
  assert.equal(replaced.activeTabId, 'restored');
});

test('twenty tabs survive 1,000 switches with no id reuse or cross-tab state leakage', () => {
  let model = createTabs(20);
  const ids = model.tabs.map((tab) => tab.id);
  assert.equal(new Set(ids).size, 20);

  for (let index = 0; index < 1_000; index += 1) {
    const tabId = ids[index % ids.length];
    model = reduceTabModel(model, { type: 'select', tabId, now: index + 100 });
  }

  assert.equal(model.tabs.length, 20);
  assert.deepEqual(model.tabs.map((tab) => tab.id), ids);
  for (let index = 0; index < model.tabs.length; index += 1) {
    const expected = index === 0 ? BROWSER_BLANK_URL : `https://example.com/${index}`;
    assert.equal(model.tabs[index].url, expected);
  }
});

test('100 create/close cycles keep ids monotonic and never resurrect closed state', () => {
  let model = createTabModel();
  const issuedIds = new Set(model.tabs.map((tab) => tab.id));

  for (let cycle = 0; cycle < 100; cycle += 1) {
    model = reduceTabModel(model, {
      type: 'create',
      url: `https://cycle.example/${cycle}`,
      now: cycle * 2,
    });
    const created = activeTab(model);
    assert.equal(issuedIds.has(created.id), false, `cycle ${cycle} reused ${created.id}`);
    issuedIds.add(created.id);
    model = reduceTabModel(model, {
      type: 'metadata',
      tabId: created.id,
      title: `cycle-${cycle}`,
      audible: true,
    });
    model = reduceTabModel(model, { type: 'close', tabId: created.id, now: cycle * 2 + 1 });
    assert.equal(model.tabs.some((tab) => tab.title === `cycle-${cycle}`), false);
  }

  assert.equal(issuedIds.size, 101);
  assert.equal(model.tabs.length, 1);
});

test('tab limit fails closed without changing the model', () => {
  const model = createTabs(MAX_BROWSER_TABS);
  const next = reduceTabModel(model, { type: 'create', url: 'https://overflow.example' });
  assert.equal(next, model);
  assert.equal(next.tabs.length, MAX_BROWSER_TABS);
});
