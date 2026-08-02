/**
 * ADR-027 D5 (P4-1) — the token system's invariants, as tests.
 *
 * A design system that is only a convention decays the first time someone is in
 * a hurry. These assert the three properties that make it a system: roles are
 * complete in every theme, the contrast a dense 13px scale depends on actually
 * holds, and the two themes stay structurally identical so a component written
 * against one cannot break in the other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THEMES,
  TEXT_ON_SURFACE,
  RADIUS,
  TYPE_SCALE,
  cssVariables,
  cssRule,
  contrastRatio,
  parseHex,
  relativeLuminance,
  type ThemeName,
} from './tokens.js';

const THEME_NAMES: ThemeName[] = ['light', 'dark'];

test('the two themes have identical token shapes', () => {
  // A token present in dark but missing in light is invisible until someone
  // toggles the theme — the worst time to discover it.
  const shape = (t: ThemeName): string[] => Object.keys(cssVariables(t)).sort();
  assert.deepEqual(shape('light'), shape('dark'));
});

test('no token is empty, padded, or a malformed colour', () => {
  for (const theme of THEME_NAMES) {
    for (const [name, value] of Object.entries(cssVariables(theme))) {
      assert.ok(value, `${theme} ${name} is empty`);
      assert.equal(value.trim(), value, `${theme} ${name} has stray whitespace`);
      if (value.startsWith('#')) {
        assert.doesNotThrow(() => parseHex(value), `${theme} ${name} is not a valid hex`);
      }
    }
  }
});

test('primary and muted text both meet WCAG AA on their own surface', () => {
  // Muted is held to the same 4.5 bar as primary deliberately: timestamps and
  // metadata are read, not decorative, and a dense 13px scale makes low
  // contrast worse rather than better.
  for (const theme of THEME_NAMES) {
    const t = THEMES[theme];
    assert.ok(
      contrastRatio(t.text.primary, t.surface[TEXT_ON_SURFACE.primary]) >= 4.5,
      `${theme} primary text fails AA`,
    );
    assert.ok(
      contrastRatio(t.text.muted, t.surface[TEXT_ON_SURFACE.muted]) >= 4.5,
      `${theme} muted text fails AA`,
    );
  }
});

test('subtle text clears the large-text floor at minimum', () => {
  for (const theme of THEME_NAMES) {
    const t = THEMES[theme];
    assert.ok(
      contrastRatio(t.text.subtle, t.surface[TEXT_ON_SURFACE.subtle]) >= 3,
      `${theme} subtle text is below the 3:1 floor`,
    );
  }
});

test('text on the accent is legible against the accent', () => {
  // This one earned itself: the dark theme's accent is a LIGHT colour, so the
  // inherited white-on-accent scored 1.2:1 — an invisible button label.
  for (const theme of THEME_NAMES) {
    const t = THEMES[theme];
    assert.ok(
      contrastRatio(t.text.onAccent, t.accent) >= 4.5,
      `${theme} text-on-accent fails AA`,
    );
  }
});

test('status colours are distinguishable from the panel they appear on', () => {
  for (const theme of THEME_NAMES) {
    const t = THEMES[theme];
    for (const [name, value] of Object.entries(t.status)) {
      assert.ok(
        contrastRatio(value, t.surface.panel) >= 3,
        `${theme} status.${name} is below the 3:1 floor`,
      );
    }
  }
});

test('the layer stack is genuinely layered', () => {
  // The floating-panel shell only reads as floating if the desk differs from a
  // panel, and the strong border must out-contrast the subtle one.
  for (const theme of THEME_NAMES) {
    const t = THEMES[theme];
    assert.notEqual(t.surface.desk, t.surface.panel, `${theme} desk equals panel`);
    assert.notEqual(t.border.subtle, t.surface.panel, `${theme} border equals panel`);
    assert.ok(
      contrastRatio(t.border.strong, t.surface.panel)
        > contrastRatio(t.border.subtle, t.surface.panel),
      `${theme} strong border is not stronger than subtle`,
    );
  }
});

test('radii increase monotonically', () => {
  const rem = (v: string): number => (v.endsWith('rem') ? parseFloat(v) : 0);
  assert.ok(rem(RADIUS.sm) < rem(RADIUS.md));
  assert.ok(rem(RADIUS.md) < rem(RADIUS.lg));
  assert.equal(RADIUS.none, '0');
});

test('type sizes increase monotonically and body is the D5 13px', () => {
  const px = (v: string): number => parseFloat(v);
  const order = [
    TYPE_SCALE.xs, TYPE_SCALE.sm, TYPE_SCALE.body,
    TYPE_SCALE.lg, TYPE_SCALE.xl, TYPE_SCALE.title,
  ];
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(px(order[i]!) > px(order[i - 1]!), `${order[i]} must exceed ${order[i - 1]}`);
  }
  assert.equal(TYPE_SCALE.body, '13px');
});

test('css generation emits sorted, prefixed custom properties', () => {
  const rule = cssRule('dark', ':root');
  assert.equal(rule.startsWith(':root {'), true);
  const names = rule.split('\n').slice(1, -1).map((l) => l.trim().split(':')[0]!);
  assert.equal(names.every((n) => n.startsWith('--dls-')), true);
  assert.deepEqual([...names], [...names].sort());
});

test('camelCase roles become kebab-case properties', () => {
  assert.ok(Object.hasOwn(cssVariables('dark'), '--dls-text-on-accent'));
});

test('luminance and contrast are bounded and ordered', () => {
  assert.ok(Math.abs(relativeLuminance('#000000') - 0) < 1e-5);
  assert.ok(Math.abs(relativeLuminance('#ffffff') - 1) < 1e-5);
  assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 0.1);
});
