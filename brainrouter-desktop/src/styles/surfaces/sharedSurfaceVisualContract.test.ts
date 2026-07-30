import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const theme = fs.readFileSync(new URL('../../theme.css', import.meta.url), 'utf8');
const panels = fs.readFileSync(new URL('./panels.css', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('./settings.css', import.meta.url), 'utf8');

test('the ordered theme manifest includes shared panels and Settings', () => {
  assert.match(theme, /@import "\.\/styles\/surfaces\/panels\.css";/);
  assert.match(theme, /@import "\.\/styles\/surfaces\/settings\.css";/);
});

test('shared surface modules are preview-scoped and semantic-token-only', () => {
  for (const source of [panels, settings]) {
    assert.match(source, /html\[data-visual-system="v2"\]/);
    assert.doesNotMatch(source, /#[\da-f]{3,8}\b/i);
    assert.doesNotMatch(source, /\b(?:rgb|rgba|hsl|hsla)\(/i);
    assert.doesNotMatch(source, /linear-gradient\(/i);
  }
});

test('shared panels remove decorative motion and retain visible focus', () => {
  assert.match(panels, /\.req-row:hover,[\s\S]*?transform:\s*none\s*!important/);
  assert.match(panels, /\.panel-body \.empty\s*\{[\s\S]*?background:\s*transparent\s*!important;[\s\S]*?border:\s*0\s*!important/);
  assert.match(panels, /button:focus-visible,[\s\S]*?outline:\s*2px solid var\(--shell-focus\)/);
  assert.match(panels, /@media \(forced-colors: active\)/);
});

test('Settings uses flat groups, responsive navigation, and forced-color boundaries', () => {
  assert.match(settings, /\.settings-modal \.set-group\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?border-top:\s*1px solid var\(--shell-divider\)/);
  assert.match(settings, /@media \(max-width: 760px\)/);
  assert.match(settings, /@media \(forced-colors: active\)/);
});
