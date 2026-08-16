import test from 'node:test';
import assert from 'node:assert/strict';
import { createBudget } from '../attachment/format/pdf/limits.js';
import { dictOf, nameOf, numberOf, parseObjectAt, scanIndirectObjects } from '../attachment/format/pdf/objects.js';

function parse(src: string) {
  return parseObjectAt(src, 0, src.length, createBudget(), 0, true);
}

test('a dictionary parses with names, numbers, references and nested arrays', () => {
  const parsed = parse('<</Type/Page/Count 3/Kids[4 0 R 5 0 R]/Box[0 0 612.5 792]>>');
  const dict = dictOf(parsed?.obj);
  assert.ok(dict);
  assert.equal(nameOf(dict.get('Type')), 'Page');
  assert.equal(numberOf(dict.get('Count')), 3);
  const kids = dict.get('Kids');
  assert.equal(kids?.t, 'array');
  assert.deepEqual(kids?.t === 'array' ? kids.v[0] : null, { t: 'ref', num: 4, gen: 0 });
  const box = dict.get('Box');
  assert.equal(box?.t === 'array' ? numberOf(box.v[2]) : null, 612.5);
});

test('two integers followed by anything but R stay two integers', () => {
  const parsed = parse('[4 0 5]');
  assert.equal(parsed?.obj.t, 'array');
  assert.equal(parsed?.obj.t === 'array' ? parsed.obj.v.length : 0, 3);
});

test('a name resolves #xx escapes', () => {
  const parsed = parse('/A#20Name#2Fwith');
  assert.equal(nameOf(parsed?.obj), 'A Name/with');
});

test('a literal string resolves escapes, octal and balanced parentheses', () => {
  const parsed = parse('(a\\)b\\\\c (inner) \\101\\n)');
  assert.equal(parsed?.obj.t, 'str');
  const value = parsed?.obj.t === 'str' ? parsed.obj.v.toString('latin1') : '';
  assert.equal(value, 'a)b\\c (inner) A\n');
});

test('a hex string decodes, padding an odd final digit', () => {
  const parsed = parse('<48656C6C6F2>');
  const value = parsed?.obj.t === 'str' ? parsed.obj.v.toString('latin1') : '';
  assert.equal(value, 'Hello ');
});

test('a stream object exposes where its bytes start', () => {
  const parsed = parse('<</Length 5>>\nstream\nABCDE\nendstream');
  assert.equal(parsed?.obj.t, 'stream');
  assert.equal(parsed?.obj.t === 'stream' ? parsed.obj.dataStart : -1, '<</Length 5>>\nstream\n'.length);
});

test('an unterminated literal ends at the buffer instead of running away', () => {
  const src = `(${'x'.repeat(5000)}`;
  const started = Date.now();
  const parsed = parse(src);
  assert.equal(parsed?.obj.t, 'str');
  assert.ok(Date.now() - started < 500);
});

test('nesting deeper than the depth bound is refused rather than recursed', () => {
  const budget = createBudget({ maxDepth: 8 });
  const src = `${'['.repeat(200)}1${']'.repeat(200)}`;
  const parsed = parseObjectAt(src, 0, src.length, budget, 0, false);
  assert.ok(parsed);
  assert.ok(budget.hit.includes('depth'));
});

test('the object scan finds every header and lets the last definition win', () => {
  const src = '%PDF-1.7\n1 0 obj <</A 1>> endobj\n2 0 obj <</B 2>> endobj\n1 0 obj <</A 9>> endobj\n';
  const found = scanIndirectObjects(src, createBudget());
  assert.deepEqual([...found.keys()].sort(), [1, 2]);
  assert.ok((found.get(1) ?? 0) > (found.get(2) ?? 0), 'the later object 1 wins');
});

test('the object scan is bounded by the object budget', () => {
  const budget = createBudget({ maxObjects: 10 });
  const src = Array.from({ length: 200 }, (_, i) => `${i + 1} 0 obj <</A 1>> endobj`).join('\n');
  const found = scanIndirectObjects(src, budget);
  assert.ok(found.size <= 11);
  assert.ok(budget.hit.includes('objects'));
});
