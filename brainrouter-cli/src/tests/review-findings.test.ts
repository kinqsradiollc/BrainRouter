import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewFindings, lastJsonBlock } from '../orchestration/reviewFindings.js';

test('parses a fenced json findings array after prose', () => {
  const out = `Here is my review.\n\n\`\`\`json\n[{"file":"src/a.ts","line":12,"severity":"bug","confidence":90,"summary":"off-by-one"}]\n\`\`\``;
  const f = parseReviewFindings(out);
  assert.equal(f.length, 1);
  assert.equal(f[0].file, 'src/a.ts');
  assert.equal(f[0].line, 12);
  assert.equal(f[0].severity, 'bug');
  assert.equal(f[0].confidence, 90);
});

test('empty array → no findings (clean review)', () => {
  assert.deepEqual(parseReviewFindings('Looks good.\n```json\n[]\n```'), []);
});

test('no json block → no findings (does not throw)', () => {
  assert.deepEqual(parseReviewFindings('I reviewed it, all fine.'), []);
});

test('malformed json → no findings (does not throw)', () => {
  assert.deepEqual(parseReviewFindings('```json\n[{bad}\n```'), []);
});

test('drops entries missing file or summary; clamps + defaults', () => {
  const out = '```json\n[{"file":"a.ts","summary":"x","severity":"weird","confidence":150},{"summary":"no file"},{"file":"b.ts"}]\n```';
  const f = parseReviewFindings(out);
  assert.equal(f.length, 1, 'only the one with file+summary survives');
  assert.equal(f[0].severity, 'info', 'unknown severity → info');
  assert.equal(f[0].confidence, 100, 'confidence clamped to 100');
});

test('accepts a {findings:[...]} wrapper and string line numbers', () => {
  const f = parseReviewFindings('```json\n{"findings":[{"file":"a.ts","summary":"x","line":"7"}]}\n```');
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 7);
});

test('lastJsonBlock picks the final block when several exist', () => {
  assert.equal(lastJsonBlock('```json\n1\n```\nthen\n```json\n2\n```'), '2');
});
