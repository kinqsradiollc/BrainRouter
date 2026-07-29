import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeTerminalCursor,
  normalizeTerminalGeometry,
  normalizeTerminalReuseKey,
} from '../terminal/index.js';

test('terminal session policy clamps untrusted geometry deterministically', () => {
  assert.deepEqual(normalizeTerminalGeometry(undefined, undefined), { cols: 80, rows: 24 });
  assert.deepEqual(normalizeTerminalGeometry(1, 0), { cols: 2, rows: 1 });
  assert.deepEqual(normalizeTerminalGeometry(4_000.9, Number.NaN), { cols: 1_000, rows: 24 });
});

test('terminal session policy normalizes reattachment keys and cursors', () => {
  assert.equal(normalizeTerminalReuseKey('  workspace:one  '), 'workspace:one');
  assert.equal(normalizeTerminalReuseKey('   '), undefined);
  assert.equal(normalizeTerminalReuseKey('x'.repeat(600))?.length, 512);
  assert.equal(normalizeTerminalCursor(-4), 0);
  assert.equal(normalizeTerminalCursor(8.9), 8);
  assert.equal(normalizeTerminalCursor(Number.POSITIVE_INFINITY), 0);
});
