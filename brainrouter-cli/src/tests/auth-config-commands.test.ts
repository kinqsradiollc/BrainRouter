import test from 'node:test';
import assert from 'node:assert/strict';
import { redactLoginErrorText } from '../entry/authConfigCommands.js';

test('login errors redact raw and percent-encoded API keys', () => {
  const apiKey = 'login key with spaces';
  for (const reflected of [apiKey, encodeURIComponent(apiKey)]) {
    const output = redactLoginErrorText(`connection failed with ${reflected}`, apiKey);
    assert.equal(output.includes('login key'), false);
    assert.equal(output.includes('with%20spaces'), false);
    assert.match(output, /\[redacted\]/);
  }
});

test('login errors retain bounded safe diagnostics', () => {
  assert.equal(
    redactLoginErrorText('connection refused by remote host', ''),
    'connection refused by remote host',
  );
});
