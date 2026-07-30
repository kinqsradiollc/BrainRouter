import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const theme = fs.readFileSync(new URL('../../theme.css', import.meta.url), 'utf8');
const terminalBrowser = fs.readFileSync(new URL('./terminalBrowser.css', import.meta.url), 'utf8');

test('the ordered theme manifest includes Terminal and Browser', () => {
  assert.match(theme, /@import "\.\/styles\/surfaces\/terminalBrowser\.css";/);
});

test('Terminal and Browser styling is preview-scoped and semantic-token-only', () => {
  assert.match(terminalBrowser, /html\[data-visual-system="v2"\]/);
  assert.doesNotMatch(terminalBrowser, /#[\da-f]{3,8}\b/i);
  assert.doesNotMatch(terminalBrowser, /\b(?:rgb|rgba|hsl|hsla)\(/i);
  assert.doesNotMatch(terminalBrowser, /linear-gradient\(/i);
});

test('Terminal and Browser retain flat chrome, focus, and forced-color states', () => {
  assert.match(terminalBrowser, /\.term-tabs \.term-tab\.active\s*\{[\s\S]*?box-shadow:\s*inset 0 -1px 0 var\(--shell-focus\)/);
  assert.match(terminalBrowser, /\.browser-tab\.active\s*\{[\s\S]*?background:\s*var\(--shell-panel\)/);
  assert.match(terminalBrowser, /\.browser-tab-select:focus-visible,[\s\S]*?outline:\s*2px solid var\(--shell-focus\)/);
  assert.match(terminalBrowser, /@media \(forced-colors: active\)/);
});
