import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewFindings, lastJsonBlock } from '../review/reviewFindings.js';

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

// Review v2 — the parser must preserve the rich fields a PR-style UI needs.
test('preserves details, suggestion, codeExcerpt, diffHunk, patch, endLine', () => {
  const out = '```json\n' + JSON.stringify([{
    file: 'src/a.ts', line: 12, endLine: 15, severity: 'high', confidence: 88,
    summary: 'off-by-one', details: 'loops to <= length, reads past the end',
    suggestion: 'use < length', codeExcerpt: 'for (let i = 0; i <= xs.length; i++) {',
    diffHunk: '- for (let i = 0; i <= xs.length; i++) {\n+ for (let i = 0; i < xs.length; i++) {',
    patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -12 +12 @@\n- i <= xs.length\n+ i < xs.length',
  }]) + '\n```';
  const [f] = parseReviewFindings(out);
  assert.equal(f.endLine, 15);
  assert.equal(f.details, 'loops to <= length, reads past the end');
  assert.equal(f.suggestion, 'use < length');
  assert.ok(f.codeExcerpt?.includes('xs.length'));
  assert.ok(f.diffHunk?.includes('+ for (let i = 0; i < xs.length'));
  assert.ok(f.patch?.includes('@@ -12 +12 @@'));
});

test('accepts excerpt/hunk aliases and string line numbers', () => {
  const [f] = parseReviewFindings('```json\n[{"file":"a.ts","summary":"x","line":"7","excerpt":"const a=1","hunk":"+const a=2"}]\n```');
  assert.equal(f.line, 7);
  assert.equal(f.codeExcerpt, 'const a=1');
  assert.equal(f.diffHunk, '+const a=2');
});

test('rich fields are simply absent when the model omits them (no crash)', () => {
  const [f] = parseReviewFindings('```json\n[{"file":"a.ts","summary":"x","severity":"high"}]\n```');
  assert.equal(f.details, undefined);
  assert.equal(f.patch, undefined);
  assert.equal(f.codeExcerpt, undefined);
});

import { stripReasoning } from '../review/reviewFindings.js';
test('stripReasoning removes closed + unclosed think/reasoning blocks', () => {
  assert.equal(stripReasoning('<think>plan is visible, 8 items</think>The fix is X.'), 'The fix is X.');
  assert.equal(stripReasoning('<thinking>noise</thinking>\n\nClean summary.'), 'Clean summary.');
  assert.equal(stripReasoning('<think>truncated reasoning with no close'), '');
  assert.equal(stripReasoning('No reasoning here.'), 'No reasoning here.');
});
