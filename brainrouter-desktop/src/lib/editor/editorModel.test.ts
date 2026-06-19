import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDirty, anyDirty, dirtyPaths, tabFromRead, openTab, setContent, markSaved,
  revertTab, closeTab, reorderTabs, nextActivePath, type EditorTab,
} from './editorModel.js';

const read = (path: string, content: string, extra = {}): Parameters<typeof tabFromRead>[0] => ({ path, content, mtimeMs: 100, size: content.length, ...extra });

test('tabFromRead: text file is editable; binary/truncated open read-only', () => {
  const t = tabFromRead(read('a.ts', 'const x=1'));
  assert.equal(t.readOnly, false); assert.equal(t.binary, false); assert.equal(t.saved, t.content);
  assert.equal(t.language, 'typescript');
  assert.equal(tabFromRead(read('img.png', '', { binary: true })).readOnly, true);
  assert.equal(tabFromRead(read('big.log', 'x', { truncated: true })).readOnly, true);
});

test('isDirty: only when buffer diverges from saved and the tab is editable', () => {
  let tabs = openTab([], read('a.ts', 'v1'));
  assert.equal(isDirty(tabs[0]), false);
  tabs = setContent(tabs, 'a.ts', 'v2');
  assert.equal(isDirty(tabs[0]), true);
  assert.deepEqual(dirtyPaths(tabs), ['a.ts']);
  assert.equal(anyDirty(tabs), true);
  // a binary tab never reports dirty even if content is forced
  const bin: EditorTab = { ...tabFromRead(read('x.bin', '', { binary: true })), content: 'changed' };
  assert.equal(isDirty(bin), false);
});

test('setContent is a no-op for read-only/binary tabs', () => {
  const tabs = openTab([], read('img.png', '', { binary: true }));
  assert.equal(setContent(tabs, 'img.png', 'hacked')[0].content, '');
});

test('markSaved clears dirty and updates mtime', () => {
  let tabs = setContent(openTab([], read('a.ts', 'v1')), 'a.ts', 'v2');
  assert.equal(isDirty(tabs[0]), true);
  tabs = markSaved(tabs, 'a.ts', 'v2', 200);
  assert.equal(isDirty(tabs[0]), false);
  assert.equal(tabs[0].saved, 'v2');
  assert.equal(tabs[0].mtimeMs, 200);
});

test('revertTab restores the saved content', () => {
  let tabs = setContent(openTab([], read('a.ts', 'v1')), 'a.ts', 'v2');
  tabs = revertTab(tabs, 'a.ts');
  assert.equal(tabs[0].content, 'v1');
  assert.equal(isDirty(tabs[0]), false);
});

test('openTab on an already-open DIRTY file preserves the unsaved buffer', () => {
  let tabs = setContent(openTab([], read('a.ts', 'v1')), 'a.ts', 'edited');
  tabs = openTab(tabs, read('a.ts', 'v1-on-disk')); // a re-open while dirty
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].content, 'edited', 'unsaved edits not clobbered');
});

test('openTab refreshes a CLEAN already-open file', () => {
  let tabs = openTab([], read('a.ts', 'v1'));
  tabs = openTab(tabs, read('a.ts', 'v2'));
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].content, 'v2');
});

test('closeTab + nextActivePath pick a sensible neighbour', () => {
  let tabs = openTab(openTab(openTab([], read('a', '')), read('b', '')), read('c', ''));
  assert.equal(nextActivePath(tabs, 'b', 'b'), 'c', 'closing active b → c (same index)');
  assert.equal(nextActivePath(tabs, 'a', 'c'), 'c', 'closing non-active keeps active c');
  tabs = closeTab(tabs, 'b');
  assert.deepEqual(tabs.map((t) => t.path), ['a', 'c']);
  assert.equal(nextActivePath(closeTab([tabs[0]], 'a'), 'a', 'a'), null, 'last tab closed → none');
});

test('reorderTabs moves an editor tab before the drop target without mutating', () => {
  const tabs = openTab(openTab(openTab([], read('a.ts', '')), read('b.ts', '')), read('c.ts', ''));
  const next = reorderTabs(tabs, 'c.ts', 'a.ts');
  assert.deepEqual(next.map((t) => t.path), ['c.ts', 'a.ts', 'b.ts']);
  assert.deepEqual(tabs.map((t) => t.path), ['a.ts', 'b.ts', 'c.ts']);
});

test('reorderTabs moves a forward-dragged tab before the drop target', () => {
  const tabs = openTab(openTab(openTab(openTab([], read('a.ts', '')), read('b.ts', '')), read('c.ts', '')), read('d.ts', ''));
  const next = reorderTabs(tabs, 'b.ts', 'd.ts');
  assert.deepEqual(next.map((t) => t.path), ['a.ts', 'c.ts', 'b.ts', 'd.ts']);
});

test('reorderTabs is stable for no-op and unknown paths', () => {
  const tabs = openTab(openTab([], read('a.ts', '')), read('b.ts', ''));
  assert.equal(reorderTabs(tabs, 'a.ts', 'a.ts'), tabs);
  assert.equal(reorderTabs(tabs, 'missing.ts', 'a.ts'), tabs);
  assert.equal(reorderTabs(tabs, 'a.ts', 'missing.ts'), tabs);
});
