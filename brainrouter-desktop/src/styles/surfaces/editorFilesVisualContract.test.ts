import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const theme = fs.readFileSync(new URL('../../theme.css', import.meta.url), 'utf8');
const editorFiles = fs.readFileSync(new URL('./editorFiles.css', import.meta.url), 'utf8');

test('the ordered theme manifest includes Editor and Files', () => {
  assert.match(theme, /@import "\.\/styles\/surfaces\/editorFiles\.css";/);
});

test('Editor and Files styling is preview-scoped and semantic-token-only', () => {
  assert.match(editorFiles, /html\[data-visual-system="v2"\]/);
  assert.doesNotMatch(editorFiles, /#[\da-f]{3,8}\b/i);
  assert.doesNotMatch(editorFiles, /\b(?:rgb|rgba|hsl|hsla)\(/i);
  assert.doesNotMatch(editorFiles, /linear-gradient\(/i);
});

test('file rows remain flat and Editor keeps native workbench boundaries', () => {
  assert.match(editorFiles, /\.tree-row:hover,[\s\S]*?transform:\s*none/);
  assert.match(editorFiles, /\.editor-tab\.active\s*\{[\s\S]*?background:\s*var\(--shell-panel\);[\s\S]*?box-shadow:\s*none/);
  assert.match(editorFiles, /\.editor-workspace\.explorer-open\s*\{[\s\S]*?grid-template-columns:\s*clamp\(180px,\s*28%,\s*300px\)/);
  assert.match(editorFiles, /@media \(forced-colors: active\)/);
});
