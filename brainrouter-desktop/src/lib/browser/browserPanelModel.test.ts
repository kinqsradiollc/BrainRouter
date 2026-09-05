import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserShortcut,
  browserTabTitle,
  browserViewRect,
  browserZoomLabel,
  nextBrowserOpenGeneration,
  normalizeBrowserInput, cycledTabIndex, shortcutTargetIsEditable } from './browserPanelModel.js';

test('normalizes URLs, loopback addresses, hostnames, and searches', () => {
  assert.equal(normalizeBrowserInput(' https://example.com/a '), 'https://example.com/a');
  assert.equal(normalizeBrowserInput('localhost:4173/app'), 'http://localhost:4173/app');
  assert.equal(normalizeBrowserInput('example.com/docs'), 'https://example.com/docs');
  assert.equal(normalizeBrowserInput('browser tabs & speed'), 'https://www.google.com/search?q=browser%20tabs%20%26%20speed');
  assert.equal(normalizeBrowserInput(''), null);
});

test('searches executable schemes and leaves normalized file URLs for the main-process path gate', () => {
  assert.equal(normalizeBrowserInput('javascript:alert(1)'), 'https://www.google.com/search?q=javascript%3Aalert(1)');
  assert.equal(normalizeBrowserInput('file:///tmp/prototype.html'), 'file:///tmp/prototype.html');
});

test('maps normal browser keyboard shortcuts on macOS and other platforms', () => {
  assert.deepEqual(browserShortcut({ key: 't', metaKey: true }), { command: 'new-tab' });
  assert.deepEqual(browserShortcut({ key: 'T', ctrlKey: true, shiftKey: true }), { command: 'reopen-tab' });
  assert.deepEqual(browserShortcut({ key: 'w', metaKey: true }), { command: 'close-tab' });
  assert.deepEqual(browserShortcut({ key: 'l', ctrlKey: true }), { command: 'focus-omnibox' });
  assert.deepEqual(browserShortcut({ key: 'f', metaKey: true }), { command: 'find' });
  assert.deepEqual(browserShortcut({ key: '4', ctrlKey: true }), { command: 'select-tab', index: 3 });
  assert.deepEqual(browserShortcut({ key: '9', metaKey: true }), { command: 'select-tab', index: 8 });
  assert.deepEqual(browserShortcut({ key: 'r', metaKey: true, shiftKey: true }), { command: 'reload', bypassCache: true });
  assert.deepEqual(browserShortcut({ key: '=', metaKey: true }), { command: 'zoom-in' });
  assert.deepEqual(browserShortcut({ key: '-', ctrlKey: true }), { command: 'zoom-out' });
  assert.deepEqual(browserShortcut({ key: '0', metaKey: true }), { command: 'zoom-reset' });
  assert.deepEqual(browserShortcut({ key: 'ArrowLeft', altKey: true }), { command: 'back' });
  assert.deepEqual(browserShortcut({ key: 'ArrowRight', altKey: true }), { command: 'forward' });
  assert.equal(browserShortcut({ key: 't' }), null);
});

test('rounds and clamps native view bounds', () => {
  assert.deepEqual(browserViewRect({ left: 12.4, top: 40.6, width: 801.8, height: 499.2 }), {
    x: 12,
    y: 41,
    width: 802,
    height: 499,
  });
  assert.deepEqual(browserViewRect({ left: -4, top: -2, width: -1, height: 0 }), { x: 0, y: 0, width: 0, height: 0 });
});

test('derives accessible fallback tab titles and zoom labels', () => {
  assert.equal(browserTabTitle('  Docs ', 'https://example.com'), 'Docs');
  assert.equal(browserTabTitle('', 'https://example.com/path'), 'example.com');
  assert.equal(browserTabTitle('', 'about:blank'), 'New tab');
  assert.equal(browserZoomLabel(1.1), '110%');
  assert.equal(browserZoomLabel(Number.NaN), '100%');
});

test('browser open generations advance monotonically and ignore stale forwards', () => {
  assert.equal(nextBrowserOpenGeneration(undefined, 4), 4);
  assert.equal(nextBrowserOpenGeneration(4, 5), 5);
  assert.equal(nextBrowserOpenGeneration(5, 5), 5);
  assert.equal(nextBrowserOpenGeneration(5, 4), 5);
  assert.equal(nextBrowserOpenGeneration(5, Number.NaN), 5);
  assert.equal(nextBrowserOpenGeneration(undefined, 0), undefined);
});

// ADR-055 P10b leftovers — tab cycling, Esc = stop, ⌘⇧J downloads; editable targets keep Esc.
test('browserShortcut: ⌘⇧[ ] cycle tabs on both bracket and brace keys, ⌘⇧J opens downloads, Esc stops', () => {
  assert.deepEqual(browserShortcut({ key: '[', metaKey: true, shiftKey: true }), { command: 'cycle-tab', delta: -1 });
  assert.deepEqual(browserShortcut({ key: '{', ctrlKey: true, shiftKey: true }), { command: 'cycle-tab', delta: -1 });
  assert.deepEqual(browserShortcut({ key: ']', metaKey: true, shiftKey: true }), { command: 'cycle-tab', delta: 1 });
  assert.deepEqual(browserShortcut({ key: '}', metaKey: true, shiftKey: true }), { command: 'cycle-tab', delta: 1 });
  assert.deepEqual(browserShortcut({ key: 'J', metaKey: true, shiftKey: true }), { command: 'downloads' });
  assert.deepEqual(browserShortcut({ key: 'Escape' }), { command: 'stop' });
  assert.equal(browserShortcut({ key: 'Escape', metaKey: true }), null);
  assert.equal(browserShortcut({ key: '[', metaKey: true }), null, 'without shift the bracket is not a tab shortcut');
});

test('cycledTabIndex wraps both ways and shortcutTargetIsEditable spots inputs and contenteditable', () => {
  assert.equal(cycledTabIndex(0, 3, -1), 2); assert.equal(cycledTabIndex(2, 3, 1), 0); assert.equal(cycledTabIndex(1, 3, 1), 2);
  assert.equal(cycledTabIndex(-1, 3, 1), 1); assert.equal(cycledTabIndex(0, 0, 1), -1);
  assert.equal(shortcutTargetIsEditable({ tagName: 'input' }), true); assert.equal(shortcutTargetIsEditable({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(shortcutTargetIsEditable({ tagName: 'DIV' }), false); assert.equal(shortcutTargetIsEditable(null), false);
});
