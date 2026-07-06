import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  beginTurnCheckpoint, endTurnCheckpoint, queueOfflinePrompt,
  readOfflineQueue, clearOfflineQueue, readRecoverable, isConnectivityError, shouldAutoReplayOffline,
  shouldRetryConnectivity, isRetryableServerError, shouldRetryLlm,
} from '../storage/checkpointStore.js';

function ws(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const NOW = '2026-05-31T12:00:00.000Z';

test('CLI-21 crash checkpoint: in-flight survives until cleared (simulating a crash vs clean turn)', () => {
  const { dir, cleanup } = ws();
  try {
    assert.deepEqual(readRecoverable(dir, 's:1'), { crashed: null, offline: [] });
    beginTurnCheckpoint(dir, 's:1', 'do the thing', NOW);
    // process "crashed" here → the in-flight checkpoint is still present
    const rec = readRecoverable(dir, 's:1');
    assert.equal(rec.crashed?.prompt, 'do the thing');
    assert.equal(rec.crashed?.kind, 'crash');
    // a clean turn would clear it
    endTurnCheckpoint(dir, 's:1');
    assert.equal(readRecoverable(dir, 's:1').crashed, null);
  } finally { cleanup(); }
});

test('CLI-21 offline queue: append, read, bounded, clear; scoped per session', () => {
  const { dir, cleanup } = ws();
  try {
    queueOfflinePrompt(dir, 's:1', 'first', NOW);
    queueOfflinePrompt(dir, 's:1', 'second', NOW);
    const q = readOfflineQueue(dir, 's:1');
    assert.deepEqual(q.map((x) => x.prompt), ['first', 'second']);
    assert.ok(q.every((x) => x.kind === 'offline'));
    // a different session is independent
    assert.deepEqual(readOfflineQueue(dir, 's:2'), []);
    clearOfflineQueue(dir, 's:1');
    assert.deepEqual(readOfflineQueue(dir, 's:1'), []);
  } finally { cleanup(); }
});

test('CLI-21 readRecoverable merges crash + offline', () => {
  const { dir, cleanup } = ws();
  try {
    beginTurnCheckpoint(dir, 's:1', 'inflight one', NOW);
    queueOfflinePrompt(dir, 's:1', 'queued one', NOW);
    const rec = readRecoverable(dir, 's:1');
    assert.equal(rec.crashed?.prompt, 'inflight one');
    assert.equal(rec.offline.length, 1);
    assert.equal(rec.offline[0].prompt, 'queued one');
  } finally { cleanup(); }
});

test('CLI-21b shouldAutoReplayOffline: enabled + connected + non-empty', () => {
  assert.equal(shouldAutoReplayOffline({ enabled: true, connected: true, count: 2 }), true);
  assert.equal(shouldAutoReplayOffline({ enabled: false, connected: true, count: 2 }), false); // disabled
  assert.equal(shouldAutoReplayOffline({ enabled: true, connected: false, count: 2 }), false); // still offline
  assert.equal(shouldAutoReplayOffline({ enabled: true, connected: true, count: 0 }), false); // nothing to replay
});

test('CLI-21 isConnectivityError: connectivity-shaped errors vs ordinary errors', () => {
  assert.equal(isConnectivityError(new Error('connect ECONNREFUSED 127.0.0.1:1234')), true);
  assert.equal(isConnectivityError(new Error('fetch failed')), true);
  assert.equal(isConnectivityError(new Error('getaddrinfo ENOTFOUND api.openai.com')), true);
  assert.equal(isConnectivityError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), true);
  assert.equal(isConnectivityError(new Error('Target content not found in file')), false);
  assert.equal(isConnectivityError(new Error('TypeError: cannot read property')), false);
});

test('shouldRetryConnectivity: retries transient network errors while attempts remain', () => {
  const net = new Error('fetch failed');
  // 3-attempt budget: retry on attempts 1 and 2, give up at 3.
  assert.equal(shouldRetryConnectivity(net, 1, 3), true);
  assert.equal(shouldRetryConnectivity(net, 2, 3), true);
  assert.equal(shouldRetryConnectivity(net, 3, 3), false, 'no retry once attempts are exhausted');
  // Never retry non-connectivity errors (context overflow, logic bugs, auth).
  assert.equal(shouldRetryConnectivity(new Error('context length exceeded'), 1, 3), false);
  assert.equal(shouldRetryConnectivity(new Error('401 Unauthorized'), 1, 3), false);
  // shouldRetryConnectivity stays scoped to CONNECTIVITY — a 504 is NOT a
  // connectivity error (the server was reached), so this predicate ignores it.
  assert.equal(shouldRetryConnectivity(new Error('OpenAI API error: 504 Gateway Time-out'), 1, 3), false);
});

test('LLM-RETRY-5XX isRetryableServerError: HTTP 5xx / gateway / 429 from message', () => {
  // The exact shape the user hit — surfaced as a string from the provider.
  assert.equal(isRetryableServerError(new Error('OpenAI API error: 504 Gateway Time-out')), true);
  assert.equal(isRetryableServerError(new Error('502 Bad Gateway')), true);
  assert.equal(isRetryableServerError(new Error('Service Unavailable')), true);
  assert.equal(isRetryableServerError(new Error('API error: 500 Internal Server Error')), true);
  assert.equal(isRetryableServerError(new Error('429 Too Many Requests')), true);
  assert.equal(isRetryableServerError(new Error('The server is overloaded')), true);
});

test('LLM-RETRY-5XX isRetryableServerError: structured status code wins', () => {
  assert.equal(isRetryableServerError(Object.assign(new Error('boom'), { status: 504 })), true);
  assert.equal(isRetryableServerError(Object.assign(new Error('boom'), { statusCode: 503 })), true);
  assert.equal(isRetryableServerError(Object.assign(new Error('boom'), { response: { status: 429 } })), true);
});

test('LLM-RETRY-5XX isRetryableServerError: deterministic client errors are NOT retryable', () => {
  assert.equal(isRetryableServerError(Object.assign(new Error('bad request'), { status: 400 })), false);
  assert.equal(isRetryableServerError(new Error('401 Unauthorized')), false);
  assert.equal(isRetryableServerError(new Error('403 Forbidden')), false);
  assert.equal(isRetryableServerError(new Error('404 Not Found')), false);
  // A bare number that is NOT a status code must not masquerade as one.
  assert.equal(isRetryableServerError(new Error('summarized 500 tokens of output')), false);
});

test('LLM-RETRY-5XX isRetryableServerError: masked upstream 400 (proxy relaying a 5xx) IS retryable', () => {
  // The exact shape the user hit: an OpenAI-compatible proxy relays an upstream
  // failure as a 400 whose body says "Upstream request failed". The structured
  // status is 400 (client error, NOT in RETRYABLE_HTTP_STATUS), so the retry
  // decision must fall through to the message and recognize the upstream marker.
  const masked = Object.assign(
    new Error('OpenAI API error: 400 Bad Request - {"error":{"message":"Error from provider (Console): Upstream request failed","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}'),
    { status: 400 },
  );
  assert.equal(isRetryableServerError(masked), true);
  // Other upstream phrasings a proxy might use.
  assert.equal(isRetryableServerError(new Error('502 - upstream connect error or disconnect/reset before headers')), true);
  assert.equal(isRetryableServerError(new Error('Bad Request - upstream timed out')), true);
  // But a GENUINE invalid-param 400 (no upstream marker) stays fatal — a retry can't fix it.
  assert.equal(isRetryableServerError(Object.assign(new Error("OpenAI API error: 400 Bad Request - Unsupported value: 'temperature' does not support 0.7"), { status: 400 })), false);
});

test('LLM-RETRY-5XX shouldRetryLlm: covers connectivity AND retryable server errors, bounded by attempts', () => {
  const gw = new Error('OpenAI API error: 504 Gateway Time-out');
  const net = new Error('fetch failed');
  // Both transient classes retry while attempts remain.
  assert.equal(shouldRetryLlm(gw, 1, 3), true);
  assert.equal(shouldRetryLlm(net, 2, 3), true);
  // Exhausted budget → give up regardless of class.
  assert.equal(shouldRetryLlm(gw, 3, 3), false, 'no retry once attempts are exhausted');
  // Deterministic errors never retry.
  assert.equal(shouldRetryLlm(new Error('context length exceeded'), 1, 3), false);
  assert.equal(shouldRetryLlm(Object.assign(new Error('bad request'), { status: 400 }), 1, 3), false);
});
