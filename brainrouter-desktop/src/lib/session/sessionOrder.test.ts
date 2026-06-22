import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeOptimistic, confirmedKeys, dropPending } from './sessionOrder.js';

const row = (k: string, mt: string) => ({ sessionKey: k, modifiedAt: mt });

test('ORDER STABILITY: a refresh with the same host data reproduces the same order', () => {
  const host = [row('b', '3'), row('a', '2'), row('c', '1')];
  assert.deepEqual(mergeOptimistic(host, []), host, 'no optimistic rows → identical order (open/resume is read-only)');
});

test('optimistic row appears immediately (newest-first) before the host confirms it', () => {
  const host = [row('a', '2')];
  const opt = [row('new', '9')];
  assert.deepEqual(mergeOptimistic(host, opt).map((r) => r.sessionKey), ['new', 'a']);
});

test('once the host includes the key, the optimistic copy is dropped (no duplicate)', () => {
  const host = [row('new', '9'), row('a', '2')];
  const opt = [row('new', '8')];
  const merged = mergeOptimistic(host, opt);
  assert.deepEqual(merged.map((r) => r.sessionKey), ['new', 'a'], 'no dup');
  assert.equal(merged.filter((r) => r.sessionKey === 'new').length, 1);
});

test('confirmedKeys reports which pending keys the host now has', () => {
  const host = [row('new', '9'), row('a', '2')];
  assert.deepEqual(confirmedKeys(host, ['new', 'other']), ['new']);
});

test('dropPending removes confirmed keys from the pending set', () => {
  const pending = [row('new', '9'), row('other', '8')];
  assert.deepEqual(dropPending(pending, ['new']).map((r) => r.sessionKey), ['other']);
});

test('REGRESSION: a refresh that races the transcript flush does NOT drop the new row', () => {
  const opt = [row('fresh', '9')];
  // host hasn't flushed the transcript yet → row absent from host
  const hostBefore = [row('a', '2')];
  assert.ok(mergeOptimistic(hostBefore, opt).some((r) => r.sessionKey === 'fresh'), 'kept while host lags');
  // host catches up → row present once, optimistic dropped
  const hostAfter = [row('fresh', '9'), row('a', '2')];
  assert.equal(mergeOptimistic(hostAfter, opt).filter((r) => r.sessionKey === 'fresh').length, 1);
});
