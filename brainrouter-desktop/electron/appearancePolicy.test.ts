import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appearanceWindowBackground,
  desktopAppearanceState,
  nativeThemeSource,
  normalizeAppearancePreference,
  resolveAppearance,
} from './appearancePolicy.js';

const lightSystem = { dark: false, highContrast: false, reducedTransparency: false };
const darkSystem = { dark: true, highContrast: false, reducedTransparency: false };

test('appearance preference migration keeps supported values and defaults to system', () => {
  assert.equal(normalizeAppearancePreference(null), 'system');
  assert.equal(normalizeAppearancePreference(''), 'system');
  assert.equal(normalizeAppearancePreference('unknown'), 'system');
  assert.equal(normalizeAppearancePreference('dark'), 'dark');
  assert.equal(normalizeAppearancePreference('hc'), 'hc');
  assert.equal(normalizeAppearancePreference('light'), 'light');
  assert.equal(normalizeAppearancePreference('system'), 'system');
});

test('system follows native color scheme while explicit modes remain explicit', () => {
  assert.equal(resolveAppearance('system', lightSystem), 'light');
  assert.equal(resolveAppearance('system', darkSystem), 'dark');
  assert.equal(resolveAppearance('light', darkSystem), 'light');
  assert.equal(resolveAppearance('dark', lightSystem), 'dark');
});

test('native high contrast wins over a lower-contrast preference', () => {
  const highContrast = { ...lightSystem, highContrast: true };
  assert.equal(resolveAppearance('system', highContrast), 'hc');
  assert.equal(resolveAppearance('light', highContrast), 'hc');
  assert.equal(resolveAppearance('hc', darkSystem), 'hc');
});

test('state, native source, and startup canvas stay in sync', () => {
  assert.deepEqual(desktopAppearanceState('system', darkSystem), {
    preference: 'system',
    resolved: 'dark',
    ...darkSystem,
  });
  assert.equal(nativeThemeSource('system'), 'system');
  assert.equal(nativeThemeSource('light'), 'light');
  assert.equal(nativeThemeSource('dark'), 'dark');
  assert.equal(nativeThemeSource('hc'), 'dark');
  assert.equal(appearanceWindowBackground('light'), '#f8f7f5');
  assert.equal(appearanceWindowBackground('dark'), '#0c0c0e');
  assert.equal(appearanceWindowBackground('hc'), '#0a0a0b');
});
