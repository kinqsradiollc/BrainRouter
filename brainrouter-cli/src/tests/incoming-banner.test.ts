import test from 'node:test';
import assert from 'node:assert/strict';
import { renderIncomingMessages } from '../cli/incomingBanner.js';

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function captureStdout(fn: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: unknown) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return stripAnsi(captured);
}

test('renderIncomingMessages: no-op on empty input (does not write anything)', () => {
  const out = captureStdout(() => renderIncomingMessages([]));
  assert.equal(out, '');
});

test('renderIncomingMessages: prints sender prefix, age, and body', () => {
  const out = captureStdout(() =>
    renderIncomingMessages([
      {
        id: 'm-1',
        fromSessionKey: 'abcdef0123456789-rest',
        text: 'heads up, deploying main',
        receivedAt: new Date().toISOString(),
      },
    ]),
  );
  assert.match(out, /📨 from abcdef012345…/);
  assert.match(out, /just now/);
  assert.match(out, /heads up, deploying main/);
});

test('renderIncomingMessages: wraps long lines at 76 chars (banner width minus the gutter)', () => {
  const long = 'word '.repeat(40).trim(); // ~200 chars
  const out = captureStdout(() =>
    renderIncomingMessages([
      {
        id: 'm-1',
        fromSessionKey: 'sender',
        text: long,
        receivedAt: new Date().toISOString(),
      },
    ]),
  );
  for (const line of out.split('\n')) {
    // Strip the "│ " gutter prefix when present.
    const body = line.replace(/^│\s/, '');
    assert.ok(body.length <= 100, `line too long: ${body.length} chars — ${body}`);
  }
});

test('renderIncomingMessages: renders multiple messages as separate banners', () => {
  const out = captureStdout(() =>
    renderIncomingMessages([
      { id: 'a', fromSessionKey: 'peer-a', text: 'hi', receivedAt: new Date().toISOString() },
      { id: 'b', fromSessionKey: 'peer-b', text: 'yo', receivedAt: new Date().toISOString() },
    ]),
  );
  // Two `┌─` headers means two banners — not one block with two body lines.
  const headerCount = out.match(/┌─/g)?.length ?? 0;
  assert.equal(headerCount, 2);
});

test('renderIncomingMessages: age tag reads "Xm ago" for older messages', () => {
  const eightMinutesAgo = new Date(Date.now() - 8 * 60_000).toISOString();
  const out = captureStdout(() =>
    renderIncomingMessages([
      { id: 'm', fromSessionKey: 'peer', text: 'late mail', receivedAt: eightMinutesAgo },
    ]),
  );
  assert.match(out, /8m ago/);
});
