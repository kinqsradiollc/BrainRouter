import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHunk, excerptRows, findingRows } from './reviewCode.js';

test('parseHunk classifies +/-/context with new-file line numbers from @@', () => {
  const rows = parseHunk('@@ -10,3 +10,3 @@\n ctx line\n-bad line\n+good line\n more ctx');
  assert.deepEqual(rows.map((r) => r.kind), ['meta', 'ctx', 'del', 'add', 'ctx']);
  assert.equal(rows[1].lineNo, 10);          // first context = new line 10
  assert.equal(rows[2].text, 'bad line');     // del keeps text, no new lineNo
  assert.equal(rows[3].lineNo, 11);           // added line advances the counter
  assert.equal(rows[4].lineNo, 12);
});

test('parseHunk tolerates a header-less loose hunk', () => {
  const rows = parseHunk('-i <= n\n+i < n');
  assert.deepEqual(rows.map((r) => r.kind), ['del', 'add']);
  assert.equal(rows[1].text, 'i < n');
});

test('excerptRows numbers from startLine and flags the problem range red', () => {
  const rows = excerptRows('a\nb\nc', 12, 13, 13);
  assert.deepEqual(rows.map((r) => r.lineNo), [12, 13, 14]);
  assert.deepEqual(rows.map((r) => r.kind), ['ctx', 'problem', 'ctx']);
});

test('findingRows prefers the diff hunk', () => {
  const rows = findingRows({ diffHunk: '-x\n+y', codeExcerpt: 'x' });
  assert.deepEqual(rows.map((r) => r.kind), ['del', 'add']);
});

test('findingRows falls back to the excerpt + appends a code-like suggestion as added', () => {
  const rows = findingRows({ codeExcerpt: 'for (i <= n)', line: 5, suggestion: 'for (i < n);' });
  assert.equal(rows[0].kind, 'problem');
  assert.equal(rows[rows.length - 1].kind, 'add');
  assert.equal(rows[rows.length - 1].text, 'for (i < n);');
});

test('findingRows is empty when there is no code', () => {
  assert.deepEqual(findingRows({ summary: 'x' } as never), []);
});
