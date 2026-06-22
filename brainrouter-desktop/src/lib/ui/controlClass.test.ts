import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buttonClass, chipClass } from './controlClass.js';

test('buttonClass: default is the bare wt-btn (byte-identical to the old inline string)', () => {
  assert.equal(buttonClass(), 'wt-btn');
  assert.equal(buttonClass('default'), 'wt-btn');
});

test('buttonClass: variants append their modifier exactly as the CSS expects', () => {
  assert.equal(buttonClass('primary'), 'wt-btn primary');
  assert.equal(buttonClass('primary-ghost'), 'wt-btn primary-ghost');
  assert.equal(buttonClass('danger'), 'wt-btn danger');
});

test('buttonClass: an extra class is appended last; empties dropped', () => {
  assert.equal(buttonClass('primary', 'mt'), 'wt-btn primary mt');
  assert.equal(buttonClass('default', 'mt'), 'wt-btn mt');
  assert.equal(buttonClass('default', ''), 'wt-btn');
});

test('chipClass: bare + with extra', () => {
  assert.equal(chipClass(), 'req-link-chip');
  assert.equal(chipClass('cur'), 'req-link-chip cur');
});
