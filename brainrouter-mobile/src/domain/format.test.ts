import test from 'node:test';
import assert from 'node:assert/strict';
import { fileFromSummary, fmtAge, fmtRel, fmtElapsed, fmtDur, wfStatusClass, fmtTokens, fmt } from './format.js';

test('fileFromSummary only fires for mutating tools and pulls the path', () => {
  assert.equal(fileFromSummary('Edited', 'Edited src/x.ts +3 -1'), 'src/x.ts');
  assert.equal(fileFromSummary('write_file', 'wrote a/b/c.tsx'), 'a/b/c.tsx');
  assert.equal(fileFromSummary('read_file', 'read src/x.ts'), undefined);
  assert.equal(fileFromSummary('grep', 'no path here'), undefined);
});

test('fmtTokens renders compact k/M', () => {
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(1234), '1.2k');
  assert.equal(fmtTokens(150_000), '150k');
  assert.equal(fmtTokens(2_500_000), '2.5M');
});

test('fmtDur renders seconds then m ss', () => {
  assert.equal(fmtDur(0), '0s');
  assert.equal(fmtDur(5_000), '5s');
  assert.equal(fmtDur(65_000), '1m 05s');
  assert.equal(fmtDur(125_000), '2m 05s');
});

test('wfStatusClass maps status to a modifier', () => {
  assert.equal(wfStatusClass('completed'), 'done');
  assert.equal(wfStatusClass('done'), 'done');
  assert.equal(wfStatusClass('running'), 'run');
  assert.equal(wfStatusClass('pending'), 'run');
  assert.equal(wfStatusClass('failed'), 'fail');
  assert.equal(wfStatusClass('stale'), 'warn');
  assert.equal(wfStatusClass('whatever'), '');
});

test('fmt stringifies strings, string arrays, and objects', () => {
  assert.equal(fmt('hello'), 'hello');
  assert.equal(fmt(['a', 'b']), 'a\nb');
  assert.equal(fmt({ a: 1 }), JSON.stringify({ a: 1 }, null, 2));
});

test('relative-time helpers are monotonic with age', () => {
  const now = Date.now();
  assert.equal(fmtRel(now), 'just now');
  assert.equal(fmtRel(now - 5 * 60_000), '5m ago');
  assert.equal(fmtRel(now - 3 * 3600_000), '3h ago');
  // fmtAge floors minutes to at least 1; fmtElapsed shows seconds under a minute.
  assert.equal(fmtAge(new Date(now - 90 * 60_000).toISOString()), '1h');
  assert.equal(fmtElapsed(new Date(now - 30_000).toISOString()), '30s');
  assert.equal(fmtElapsed(undefined), '');
});
