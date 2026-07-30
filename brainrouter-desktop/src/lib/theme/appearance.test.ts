import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialAppearancePreference,
  normalizeAppearancePreference,
  resolveAppearance,
} from './appearance.js';

test('new installs default to System while legacy dark and hc values migrate unchanged', () => {
  assert.equal(initialAppearancePreference(null), 'system');
  assert.equal(initialAppearancePreference(null, 'dark'), 'dark');
  assert.equal(initialAppearancePreference('dark', 'system'), 'dark');
  assert.equal(initialAppearancePreference('hc', 'system'), 'hc');
  assert.equal(normalizeAppearancePreference('invalid'), 'system');
});

test('effective appearance follows system only when the stored preference is System', () => {
  assert.equal(resolveAppearance('system', { dark: false, highContrast: false }), 'light');
  assert.equal(resolveAppearance('system', { dark: true, highContrast: false }), 'dark');
  assert.equal(resolveAppearance('light', { dark: true, highContrast: false }), 'light');
  assert.equal(resolveAppearance('dark', { dark: false, highContrast: false }), 'dark');
  assert.equal(resolveAppearance('light', { dark: false, highContrast: true }), 'hc');
});
