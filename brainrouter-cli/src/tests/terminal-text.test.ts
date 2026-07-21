import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTerminalText } from '../cli/terminalText.js';

test('terminal text strips control, line, and bidi characters and bounds output', () => {
  const output = sanitizeTerminalText(
    `safe\u001b]8;;https://example.test\u0007link\nforged\u202e${'x'.repeat(8 * 1024)}`,
  );
  assert.equal(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(output), false);
  assert.match(output, /^safe\]8;;https:\/\/example\.testlinkforged/);
  assert.ok(output.length <= 4 * 1024);
});
