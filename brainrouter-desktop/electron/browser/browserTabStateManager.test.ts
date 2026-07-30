import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserManagerError } from './browserManagerError.js';
import { BrowserTabStateManager } from './browserTabStateManager.js';
import { BROWSER_BLANK_URL, MAX_BROWSER_TABS } from './protocol.js';

test('browser tab state preserves creation, selection, and reorder order', () => {
  const manager = new BrowserTabStateManager('window');
  const first = manager.create('https://one.test/');
  const second = manager.create('https://two.test/');
  manager.select(first.id);
  const reordered = manager.reorder(second.id, 0);

  assert.deepEqual(reordered.map((tab) => tab.id), [second.id, first.id]);
  assert.equal(manager.activeTabId, first.id);
  assert.equal(manager.get()?.id, first.id);
});

test('closing the active tab selects its nearest surviving neighbor', () => {
  const manager = new BrowserTabStateManager('window');
  const first = manager.create('https://one.test/');
  const second = manager.create('https://two.test/');
  const third = manager.create('https://three.test/');
  manager.select(second.id);
  const removed = manager.remove(second.id);

  assert.equal(removed.activeChanged, true);
  assert.equal(removed.needsBlankTab, false);
  assert.equal(manager.activeTabId, third.id);
  assert.equal(manager.takeClosed()?.url, 'https://two.test/');
  assert.equal(manager.get(first.id)?.id, first.id);
});

test('closing the last tab requests a replacement and does not retain blank tabs', () => {
  const manager = new BrowserTabStateManager('window');
  const blank = manager.create(BROWSER_BLANK_URL);
  manager.select(blank.id);
  const removed = manager.remove(blank.id);

  assert.equal(removed.needsBlankTab, true);
  assert.equal(manager.activeTabId, '');
  assert.equal(manager.closedCount, 0);
});

test('browser tab state rejects overflow and unknown tab operations', () => {
  const manager = new BrowserTabStateManager('window');
  for (let index = 0; index < MAX_BROWSER_TABS; index += 1) {
    manager.create(`https://example.test/${index}`);
  }
  assert.throws(
    () => manager.create('https://overflow.test/'),
    (error) =>
      error instanceof BrowserManagerError && error.code === 'TAB_LIMIT',
  );
  assert.throws(
    () => manager.ensureCanCreate(),
    (error) =>
      error instanceof BrowserManagerError && error.code === 'TAB_LIMIT',
  );
  assert.throws(
    () => manager.select('missing'),
    (error) =>
      error instanceof BrowserManagerError && error.code === 'TAB_NOT_FOUND',
  );
});
