import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCombo, SHORTCUTS, SHORTCUT_AREAS, captureCombo, resolveShortcutOverrides } from './shortcuts.js';

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

// §5.9 — customizable shortcuts: capture + override resolution
test('captureCombo: builds neutral combos; modifier-only → null', () => {
  assert.equal(captureCombo({ key: 'd', metaKey: true, shiftKey: true }, 'mac'), 'Mod+Shift+D');
  assert.equal(captureCombo({ key: 'k', ctrlKey: true }, 'windows'), 'Mod+K', 'Ctrl is the accelerator off mac');
  assert.equal(captureCombo({ key: '`', ctrlKey: true }, 'mac'), 'Ctrl+Backtick', 'literal Ctrl on mac');
  assert.equal(captureCombo({ key: 'ArrowUp', altKey: true }, 'mac'), 'Alt+Up');
  assert.equal(captureCombo({ key: 'Meta', metaKey: true }, 'mac'), null, 'modifier alone is not a chord');
});

test('captureCombo round-trips through formatCombo for display', () => {
  const combo = captureCombo({ key: 'd', metaKey: true, shiftKey: true }, 'mac')!;
  assert.equal(formatCombo(combo, 'mac'), '⌘⇧D');
  assert.equal(formatCombo(combo, 'windows'), 'Ctrl+Shift+D');
});

test('resolveShortcutOverrides: defaults collision-free; an override applies to one shortcut', () => {
  assert.deepEqual(resolveShortcutOverrides({}).conflicts, []);
  const { shortcuts } = resolveShortcutOverrides({ 'editor-save': 'Mod+Shift+S' });
  assert.equal(shortcuts.find((s) => s.id === 'editor-save')!.combo, 'Mod+Shift+S');
  assert.equal(shortcuts.find((s) => s.id === 'editor-find')!.combo, 'Mod+F', 'others unchanged');
});

test('resolveShortcutOverrides: within-area collision reported; cross-area sharing is not', () => {
  const clash = resolveShortcutOverrides({ 'editor-find': 'Mod+S' });
  assert.ok(clash.conflicts.some(([a, b]) =>
    (a === 'editor-save' && b === 'editor-find') || (a === 'editor-find' && b === 'editor-save')));
  // `Escape` is shared by panel-close (Panels) and stop (Composer) — different areas, no conflict.
  assert.ok(!resolveShortcutOverrides({}).conflicts.some(([a, b]) =>
    [a, b].includes('panel-close') && [a, b].includes('stop')));
});
