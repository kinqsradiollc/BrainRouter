import assert from 'node:assert/strict';
import test from 'node:test';
import {
  visualSystemDataValue,
  visualSystemEnabled,
} from './visualSystem.js';

test('the new visual system remains disabled unless explicitly enabled', () => {
  assert.equal(visualSystemEnabled(null), false);
  assert.equal(visualSystemEnabled(false), false);
  assert.equal(visualSystemEnabled('false'), false);
  assert.equal(visualSystemEnabled('0'), false);
  assert.equal(visualSystemEnabled(true), true);
  assert.equal(visualSystemEnabled('true'), true);
  assert.equal(visualSystemEnabled('1'), true);
});

test('the document contract exposes an explicit reversible state', () => {
  assert.equal(visualSystemDataValue(false), 'legacy');
  assert.equal(visualSystemDataValue(true), 'v2');
});
