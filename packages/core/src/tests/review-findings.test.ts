import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lastJsonBlock,
  parseReviewFindings,
  parseReviewFindingsEnvelope,
  REVIEW_OUTPUT_CONTRACT,
} from '../review/reviewFindings.js';

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

test('publication envelope requires exact severity, confidence, and line types', () => {
  const invalid = [
    { file: 'a.ts', summary: 'missing severity', confidence: 90 },
    { file: 'a.ts', summary: 'unknown severity', severity: 'important', confidence: 90 },
    { file: 'a.ts', summary: 'missing confidence', severity: 'high' },
    { file: 'a.ts', summary: 'clamped confidence', severity: 'high', confidence: 101 },
    { file: 'a.ts', summary: 'string line', severity: 'high', confidence: 90, line: '7' },
    { file: 'a.ts', summary: 'backward range', severity: 'high', confidence: 90, line: 8, endLine: 7 },
  ];
  for (const finding of invalid) {
    const result = parseReviewFindingsEnvelope(`\`\`\`json\n${JSON.stringify([finding])}\n\`\`\``);
    assert.equal(result.ok, false, JSON.stringify(finding));
  }
});

test('publication envelope refuses unknown fields and malformed optional values', () => {
  const base = { file: 'a.ts', summary: 'real issue', severity: 'high', confidence: 90 };
  for (const finding of [
    { ...base, message: 'schema drift' },
    { ...base, preExisting: 'true' },
    { ...base, details: '' },
  ]) {
    const result = parseReviewFindingsEnvelope(`\`\`\`json\n${JSON.stringify([finding])}\n\`\`\``);
    assert.equal(result.ok, false, JSON.stringify(finding));
  }
});

test('publication envelope accepts the documented strict finding shape', () => {
  const result = parseReviewFindingsEnvelope('```json\n' + JSON.stringify({ findings: [{
    file: 'src/a.ts',
    line: 12,
    endLine: 13,
    severity: 'critical',
    preExisting: false,
    confidence: 97,
    summary: 'unsafe boundary',
    details: 'The checked input reaches the sink.',
    suggestion: 'Validate it first.',
    replacement: 'safeCall(input);',
    codeExcerpt: 'unsafeCall(input);',
    diffHunk: '-unsafeCall(input);\n+safeCall(input);',
    patch: '--- a/src/a.ts\n+++ b/src/a.ts',
  }] }) + '\n```');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.findings[0]?.severity, 'critical');
    assert.equal(result.findings[0]?.line, 12);
    assert.equal(result.findings[0]?.preExisting, undefined);
  }
});

test('publication envelope accepts documented null lines as a file-only finding', () => {
  const result = parseReviewFindingsEnvelope(
    '```json\n[{"file":"src/a.ts","line":null,"endLine":null,"severity":"medium","confidence":80,"summary":"file-level issue"}]\n```',
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.findings[0]?.line, undefined);
    assert.equal(result.findings[0]?.endLine, undefined);
  }
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

// Claude-style Pre-existing (🟣) — a bug the diff touches but did not introduce.
test('parses preExisting from a boolean field', () => {
  const [f] = parseReviewFindings('```json\n[{"file":"a.ts","summary":"leaks fd","severity":"high","preExisting":true}]\n```');
  assert.equal(f.preExisting, true);
});

test('parses preExisting from a "pre-existing" severity label', () => {
  const [f] = parseReviewFindings('```json\n[{"file":"a.ts","summary":"latent race","severity":"pre-existing"}]\n```');
  assert.equal(f.preExisting, true);
  assert.equal(f.severity, 'info', 'the "pre-existing" label is not a real severity → coerced to info');
});

test('preExisting is absent (undefined) for a normal finding', () => {
  const [f] = parseReviewFindings('```json\n[{"file":"a.ts","summary":"x","severity":"high"}]\n```');
  assert.equal(f.preExisting, undefined);
});

test('REVIEW_OUTPUT_CONTRACT is tool-aware (read-only but tells the reviewer which tools to call)', () => {
  const c = REVIEW_OUTPUT_CONTRACT;
  // It must NOT forbid all tools anymore, and must name the read tools + the verification bar.
  assert.ok(!/call any tools/i.test(c) || /SHOULD call/i.test(c), 'no blanket "do not call any tools"');
  assert.ok(c.includes('read_file'), 'names read_file');
  assert.ok(c.includes('grep_search'), 'names grep_search');
  assert.ok(/VERIFICATION BAR/.test(c), 'states a verification bar');
  assert.ok(/pre-existing/i.test(c) && /preExisting/.test(c), 'documents the pre-existing severity');
  assert.ok(/READ-ONLY/i.test(c) && /MUST NOT edit/i.test(c), 'still read-only: no edits/writes');
});

import { stripReasoning } from '../review/reviewFindings.js';
test('stripReasoning removes closed + unclosed think/reasoning blocks', () => {
  assert.equal(stripReasoning('<think>plan is visible, 8 items</think>The fix is X.'), 'The fix is X.');
  assert.equal(stripReasoning('<thinking>noise</thinking>\n\nClean summary.'), 'Clean summary.');
  assert.equal(stripReasoning('<think>truncated reasoning with no close'), '');
  assert.equal(stripReasoning('No reasoning here.'), 'No reasoning here.');
});
