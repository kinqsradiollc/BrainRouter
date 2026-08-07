/**
 * ADR-028 · CodeQL `js/polynomial-redos`.
 *
 * `/\/+$/` costs O(n²) on a long run of slashes, because an anchored `+` makes
 * the engine retry from every position. These do it in one pass, and the test
 * that matters is the pathological input — the one the regex choked on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trimTrailing, trimLeading, trimTrailingAny, stripTrailingSlashes, stripLeadingSlashes,
} from '../util/trimEdges.js';

test('trailing characters are stripped, however many there are', () => {
  assert.equal(stripTrailingSlashes('https://x.test///'), 'https://x.test');
  assert.equal(stripTrailingSlashes('https://x.test'), 'https://x.test');
  assert.equal(stripTrailingSlashes('///'), '');
  assert.equal(stripTrailingSlashes(''), '');
});

test('leading characters are stripped', () => {
  assert.equal(stripLeadingSlashes('///a/b'), 'a/b');
  assert.equal(stripLeadingSlashes('a/b'), 'a/b');
});

test('only the EDGE is touched — interior runs survive', () => {
  // The bug a naive `replaceAll` would introduce.
  assert.equal(stripTrailingSlashes('a//b//'), 'a//b');
  assert.equal(stripLeadingSlashes('//a//b'), 'a//b');
});

test('a character set trims any of its members', () => {
  assert.equal(trimTrailingAny('see this).,;', ').,;'), 'see this');
  assert.equal(trimTrailingAny('clean', ').,;'), 'clean');
});

test('the pathological input finishes immediately', () => {
  // 200k slashes. The anchored regex this replaces is quadratic here; one pass
  // is linear. A generous bound — the point is that it terminates, not the
  // exact number.
  const long = '/'.repeat(200_000);
  const started = Date.now();
  assert.equal(stripTrailingSlashes(`${long}x${long}`), `${long}x`);
  assert.ok(Date.now() - started < 1000, 'linear, not quadratic');
});

test('a non-slash character works the same way', () => {
  assert.equal(trimTrailing('line\n\n\n', '\n'), 'line');
  assert.equal(trimLeading('  x', ' '), 'x');
});
