import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const theme = fs.readFileSync(new URL('../../theme.css', import.meta.url), 'utf8');
const track = fs.readFileSync(new URL('./track.css', import.meta.url), 'utf8');

test('the ordered theme manifest includes Track', () => {
  assert.match(theme, /@import "\.\/styles\/surfaces\/track\.css";/);
});

test('Track styling is preview-scoped and semantic-token-only', () => {
  assert.match(track, /html\[data-visual-system="v2"\]/);
  assert.doesNotMatch(track, /#[\da-f]{3,8}\b/i);
  assert.doesNotMatch(track, /\b(?:rgb|rgba|hsl|hsla)\(/i);
  assert.doesNotMatch(track, /linear-gradient\(/i);
});

test('Track keeps flat cards, a native detail drawer, and accessible states', () => {
  assert.match(track, /\.track-card\s*\{[\s\S]*?padding:/);
  assert.match(track, /\.track-card:hover,[\s\S]*?transform:\s*none/);
  assert.match(track, /\.track-detail\s*\{[\s\S]*?border-radius:\s*0/);
  assert.match(track, /\.track button:focus-visible,[\s\S]*?outline:\s*2px solid var\(--shell-focus\)/);
  assert.match(track, /@media \(forced-colors: active\)/);
});
