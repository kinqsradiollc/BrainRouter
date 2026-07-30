/**
 * ADR-026 D26-4 — static contract for the reversible Chat/composer migration.
 *
 * Renderer tests are intentionally DOM-free. This pins style ownership,
 * semantic colors, and the accessible queue/steer selector contract.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const theme = readFileSync(new URL('../../theme.css', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../../styles/surfaces/chat.css', import.meta.url), 'utf8');
const composer = readFileSync(new URL('../../styles/surfaces/composer.css', import.meta.url), 'utf8');
const composerComponent = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8');

test('Chat and composer styles are preview-scoped and use semantic colors', () => {
  for (const source of [chat, composer]) {
    assert.match(source, /html\[data-visual-system="v2"\]/);
    assert.doesNotMatch(source, /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i);
  }
  assert.match(theme, /@import "\.\/styles\/surfaces\/chat\.css";/);
  assert.match(theme, /@import "\.\/styles\/surfaces\/composer\.css";/);
});

test('queue and steer remain visible, selectable delivery modes', () => {
  assert.match(composerComponent, /data-delivery-mode=\{deliveryMode\}/);
  assert.match(composerComponent, /aria-haspopup="menu" aria-expanded=\{deliveryMenuOpen\}/);
  assert.equal((composerComponent.match(/role="menuitemradio"/g) ?? []).length, 2);
  assert.match(composerComponent, /aria-checked=\{deliveryMode === 'queue'\}/);
  assert.match(composerComponent, /aria-checked=\{deliveryMode === 'steer'\}/);
  assert.match(chat, /\.delivery-badge\.steer/);
  assert.match(chat, /\.delivery-badge\.state-canceled/);
});
