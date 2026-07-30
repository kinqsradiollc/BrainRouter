import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalTheme } from './terminalTheme.js';

function styles(values: Record<string, string>): { getPropertyValue: (name: string) => string } {
  return { getPropertyValue: (name) => values[name] ?? '' };
}

test('terminal theme resolves workbench and ANSI semantic tokens', () => {
  const theme = terminalTheme(styles({
    '--term-bg': '#010203',
    '--text': '#f0f1f2',
    '--terminal-selection': '#aabbcc44',
    '--terminal-ansi-red': '#d00000',
    '--terminal-ansi-bright-blue': '#0088ff',
  }));

  assert.equal(theme.background, '#010203');
  assert.equal(theme.foreground, '#f0f1f2');
  assert.equal(theme.cursorAccent, '#010203');
  assert.equal(theme.selectionBackground, '#aabbcc44');
  assert.equal(theme.red, '#d00000');
  assert.equal(theme.brightBlue, '#0088ff');
});

test('terminal theme keeps safe literal fallbacks when a token is absent', () => {
  const theme = terminalTheme(styles({}));
  assert.equal(theme.background, '#121212');
  assert.equal(theme.foreground, '#ececec');
  assert.equal(theme.green, '#b5bd68');
});
