import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCombo, SHORTCUTS, SHORTCUT_AREAS } from './shortcuts.js';

test('formatCombo: macOS renders concatenated glyphs', () => {
  assert.equal(formatCombo('Mod+Shift+D', 'mac'), '⌘⇧D');
  assert.equal(formatCombo('Mod+K', 'mac'), '⌘K');
  assert.equal(formatCombo('Ctrl+Backtick', 'mac'), '⌃`');
  assert.equal(formatCombo('Shift+Enter', 'mac'), '⇧↵');
});

test('formatCombo: Windows/Linux render Ctrl/Shift joined with +', () => {
  assert.equal(formatCombo('Mod+Shift+D', 'windows'), 'Ctrl+Shift+D');
  assert.equal(formatCombo('Mod+K', 'linux'), 'Ctrl+K');
  assert.equal(formatCombo('Mod+,', 'windows'), 'Ctrl+,');
  assert.equal(formatCombo('Ctrl+Backtick', 'windows'), 'Ctrl+`');
});

test('SHORTCUTS: no combo leaks the neutral Mod token, every area is known', () => {
  for (const sc of SHORTCUTS) {
    assert.ok(!formatCombo(sc.combo, 'windows').includes('Mod'), `${sc.id} leaked Mod on windows`);
    assert.ok(!formatCombo(sc.combo, 'mac').includes('Mod'), `${sc.id} leaked Mod on mac`);
    assert.ok(SHORTCUT_AREAS.includes(sc.area), `${sc.id} has unknown area ${sc.area}`);
  }
});
