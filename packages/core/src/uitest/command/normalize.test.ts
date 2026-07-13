import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResult, classifyArtifacts, errorResult } from './normalize.js';

test('valid raw reply is passed through with artifacts defaulted', () => {
  const r = normalizeResult({ ok: true, status: 'ok', command: 'tap', testID: 'x', durationMs: 5 }, { command: 'tap' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.artifacts, { screenshots: [], videos: [], logs: [], other: [] });
});

test('malformed raw reply becomes a typed error, never surfaced raw', () => {
  const r = normalizeResult({ ok: 'yes', command: 'tap' }, { command: 'tap', testID: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'error');
  assert.equal(r.testID, 'x');
  assert.match(r.error ?? '', /malformed driver result/);
});

test('null/garbage raw replies are rejected', () => {
  assert.equal(normalizeResult(null, { command: 'tap' }).ok, false);
  assert.equal(normalizeResult('not-json', { command: 'tap' }).ok, false);
});

test('classifyArtifacts buckets by extension', () => {
  const a = classifyArtifacts(['a.png', 'b.webm', 'c.log', 'd.bin', 'e/f.jpeg']);
  assert.deepEqual(a.screenshots, ['a.png', 'e/f.jpeg']);
  assert.deepEqual(a.videos, ['b.webm']);
  assert.deepEqual(a.logs, ['c.log']);
  assert.deepEqual(a.other, ['d.bin']);
});

test('errorResult is a well-formed failure', () => {
  const r = errorResult('navigate', 'unreachable', { command: 'navigate', screen: 'login' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'error');
  assert.equal(r.screen, 'login');
});
