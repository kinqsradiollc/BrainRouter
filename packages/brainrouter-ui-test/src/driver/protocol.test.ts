import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeLine, LineDecoder } from './protocol.js';
import { buildSelector, cssEscapeAttr } from './playwrightDriver.js';

test('encodeLine frames one object per newline', () => {
  assert.equal(encodeLine({ a: 1 }), '{"a":1}\n');
});

test('LineDecoder reassembles objects split across chunks', () => {
  const d = new LineDecoder();
  assert.deepEqual(d.push('{"reqId":"r1",'), []);
  const out = d.push('"result":{"ok":true}}\n');
  assert.deepEqual(out, [{ reqId: 'r1', result: { ok: true } }]);
});

test('LineDecoder is CRLF-safe and skips blank/non-JSON lines', () => {
  const d = new LineDecoder();
  const out = d.push('{"a":1}\r\n\r\nnot json\n{"b":2}\n');
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

test('LineDecoder yields multiple objects from one chunk', () => {
  const d = new LineDecoder();
  assert.deepEqual(d.push('{"x":1}\n{"y":2}\n'), [{ x: 1 }, { y: 2 }]);
});

test('buildSelector resolves a testID to a data-testid attribute selector', () => {
  assert.equal(buildSelector('login-submit'), '[data-testid="login-submit"]');
});

test('cssEscapeAttr escapes quotes and backslashes', () => {
  assert.equal(cssEscapeAttr('a"b\\c'), 'a\\"b\\\\c');
  assert.equal(buildSelector('a"b'), '[data-testid="a\\"b"]');
});
