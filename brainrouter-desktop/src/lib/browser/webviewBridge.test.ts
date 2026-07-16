import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorCenter } from './webviewBridge.js';

test('cursorCenter returns the geometric center of a rect', () => {
  assert.deepEqual(cursorCenter({ left: 0, top: 0, width: 100, height: 40 }), { x: 50, y: 20 });
});

test('cursorCenter accounts for the rect offset (scrolled/positioned element)', () => {
  assert.deepEqual(cursorCenter({ left: 200, top: 120, width: 60, height: 20 }), { x: 230, y: 130 });
});

test('cursorCenter handles a zero-size rect (collapsed element) as its own point', () => {
  assert.deepEqual(cursorCenter({ left: 12, top: 8, width: 0, height: 0 }), { x: 12, y: 8 });
});
