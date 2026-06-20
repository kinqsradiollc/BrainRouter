import test from 'node:test';
import assert from 'node:assert/strict';
import { reconnectBackoffMs, parseRetryAfterMs } from '../mcp/reconnect.js';

test('RECONNECT reconnectBackoffMs: exponential base·2^(n-1) with jitter, capped', () => {
  // Deterministic jitter=1.0 → pure exponential off the 500ms base.
  assert.equal(reconnectBackoffMs(1, { jitter: 1 }), 500);
  assert.equal(reconnectBackoffMs(2, { jitter: 1 }), 1000);
  assert.equal(reconnectBackoffMs(3, { jitter: 1 }), 2000);
  assert.equal(reconnectBackoffMs(4, { jitter: 1 }), 4000);
  // Capped.
  assert.equal(reconnectBackoffMs(20, { jitter: 1, capMs: 30_000 }), 30_000);
  // Jitter scales within bounds.
  const lo = reconnectBackoffMs(3, { jitter: 0.9 });
  const hi = reconnectBackoffMs(3, { jitter: 1.1 });
  assert.equal(lo, 1800);
  assert.equal(hi, 2200);
  // attempt < 1 clamps to 1.
  assert.equal(reconnectBackoffMs(0, { jitter: 1 }), 500);
});

test('RECONNECT reconnectBackoffMs: a positive Retry-After wins (still capped)', () => {
  assert.equal(reconnectBackoffMs(1, { retryAfterMs: 7000, jitter: 1 }), 7000);
  assert.equal(reconnectBackoffMs(5, { retryAfterMs: 7000, jitter: 1 }), 7000, 'overrides exponential');
  assert.equal(reconnectBackoffMs(1, { retryAfterMs: 99_000, capMs: 30_000 }), 30_000, 'capped');
  // Zero/negative Retry-After is ignored → falls back to exponential.
  assert.equal(reconnectBackoffMs(2, { retryAfterMs: 0, jitter: 1 }), 1000);
});

test('RECONNECT parseRetryAfterMs: delta-seconds, HTTP-date, and absent/garbage', () => {
  assert.equal(parseRetryAfterMs('5'), 5000);
  assert.equal(parseRetryAfterMs('  12 '), 12_000);
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs(undefined), undefined);
  assert.equal(parseRetryAfterMs('soon'), undefined);
  // HTTP-date relative to a fixed `now`.
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:00 GMT', now + 5000), 0, 'past date clamps to 0');
});
