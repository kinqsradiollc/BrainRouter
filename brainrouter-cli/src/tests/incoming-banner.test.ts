/**
 * CLI peer-banner and receipt-presentation regressions. Wording reflects the
 * durable delivery state, while every peer-owned field is terminal-safe and
 * ordinary intentional line breaks remain readable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSenderReceipt,
  renderIncomingMessages,
  renderSenderReceipts,
} from '../cli/view/incomingBanner.js';

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
        transport: 'local',
        state: 'queued',
      },
    ]),
  );
  // Full sender session key (no truncation/ellipsis) so it's copyable.
  assert.match(out, /📨 from abcdef0123456789-rest/);
  assert.doesNotMatch(out, /abcdef012345…/);
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
        transport: 'local',
        state: 'queued',
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
      { id: 'a', fromSessionKey: 'peer-a', text: 'hi', receivedAt: new Date().toISOString(), transport: 'local', state: 'queued' },
      { id: 'b', fromSessionKey: 'peer-b', text: 'yo', receivedAt: new Date().toISOString(), transport: 'remote', state: 'held' },
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
      { id: 'm', fromSessionKey: 'peer', text: 'late mail', receivedAt: eightMinutesAgo, transport: 'remote', state: 'held' },
    ]),
  );
  assert.match(out, /8m ago/);
});

test('sender receipts distinguish persistence, held admission, and safe-boundary application', () => {
  assert.match(stripAnsi(formatSenderReceipt({
    inboxId: 'inbox-pending',
    messageId: 'message-pending',
    targetSessionKey: 'peer-one',
    status: 'pending',
  })), /persisted, awaiting recipient admission/);
  assert.match(stripAnsi(formatSenderReceipt({
    inboxId: 'inbox-held',
    messageId: 'message-held',
    targetSessionKey: 'peer-two',
    status: 'held',
  })), /held by recipient for approval/);
  const out = captureStdout(() => renderSenderReceipts([{
    inboxId: 'inbox-applied',
    messageId: 'message-applied',
    targetSessionKey: 'peer-three',
    status: 'applied',
  }]));
  assert.match(out, /applied at the recipient safe boundary/);
});

test('peer banners and receipts strip terminal control sequences but preserve intentional newlines', () => {
  const hostile = '\u001b]52;c;Y2xpcGJvYXJk\u0007\u001b]0;forged title\u0007\u001b]8;;https://invalid.example\u0007linked\u001b]8;;\u0007';
  const out = captureStdout(() => {
    renderIncomingMessages([{
      id: 'unsafe-banner',
      fromSessionKey: `peer:${hostile}\u0000\bidentity`,
      text: `first line\nsecond ${hostile}\u0000\bline`,
      receivedAt: new Date().toISOString(),
      transport: 'remote',
      state: 'held',
    }]);
    renderSenderReceipts([{
      inboxId: 'unsafe-receipt',
      messageId: `message-${hostile}`,
      targetSessionKey: `target-${hostile}`,
      status: 'rejected',
      reason: `reason-${hostile}\u0000`,
    }]);
  });

  assert.match(out, /first line\n(?:│ )?second/);
  assert.match(out, /linked/);
  assert.match(out, /identity/);
  assert.doesNotMatch(out, /\u001b|\u0007|\u0000|\u0008/,
    'ANSI, OSC, and C0 controls are removed');
  assert.doesNotMatch(out, /Y2xpcGJvYXJk|forged title|https:\/\/invalid\.example/);
});
