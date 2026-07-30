import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferTypeAndAction } from './infer.js';

const I = (over: Partial<Parameters<typeof inferTypeAndAction>[0]> = {}) =>
  inferTypeAndAction({ jsxTag: '', hasOnClick: false, hasHref: false, ...over });

test('button tag and Button component → button/tap', () => {
  assert.deepEqual(I({ jsxTag: 'button' }), { type: 'button', action: 'tap' });
  assert.deepEqual(I({ jsxTag: 'Button' }), { type: 'button', action: 'tap' });
  assert.deepEqual(I({ jsxTag: 'IconButton' }), { type: 'button', action: 'tap' });
  assert.deepEqual(I({ jsxTag: 'motion.button' }), { type: 'button', action: 'tap' });
});

test('input-like tags → input/type', () => {
  assert.deepEqual(I({ jsxTag: 'input' }), { type: 'input', action: 'type' });
  assert.deepEqual(I({ jsxTag: 'textarea' }), { type: 'input', action: 'type' });
  assert.deepEqual(I({ jsxTag: 'TextField' }), { type: 'input', action: 'type' });
  assert.deepEqual(I({ jsxTag: 'TextInput' }), { type: 'input', action: 'type' });
});

test('anchors/links → link, navigate only when href/to present', () => {
  assert.deepEqual(I({ jsxTag: 'a', hasHref: true }), { type: 'link', action: 'navigate' });
  assert.deepEqual(I({ jsxTag: 'a', hasHref: false }), { type: 'link', action: 'tap' });
  assert.deepEqual(I({ jsxTag: 'NavLink', hasHref: true }), { type: 'link', action: 'navigate' });
  assert.deepEqual(I({ jsxTag: 'Link', hasHref: false }), { type: 'link', action: 'tap' });
});

test('select-like tags → select/tap', () => {
  assert.deepEqual(I({ jsxTag: 'select' }), { type: 'select', action: 'tap' });
  assert.deepEqual(I({ jsxTag: 'Dropdown' }), { type: 'select', action: 'tap' });
});

test('ARIA role overrides the tag', () => {
  assert.deepEqual(I({ jsxTag: 'div', role: 'button' }), { type: 'button', action: 'tap' });
  assert.deepEqual(I({ jsxTag: 'span', role: 'textbox' }), { type: 'input', action: 'type' });
  assert.deepEqual(I({ jsxTag: 'div', role: 'link', hasHref: true }), { type: 'link', action: 'navigate' });
});

test('clickable fallback then presence default', () => {
  assert.deepEqual(I({ jsxTag: 'div', hasOnClick: true }), { type: 'button', action: 'tap' });
  assert.deepEqual(I({ jsxTag: 'div' }), { type: 'element', action: 'assertVisible' });
  assert.deepEqual(I({ jsxTag: 'CustomThing' }), { type: 'element', action: 'assertVisible' });
});
