import test from 'node:test';
import assert from 'node:assert/strict';
import {
  truncateFullRead,
  READ_FILE_MAX_LINES,
  READ_FILE_MAX_CHARS,
} from '../agent/readTruncation.js';

test('truncateFullRead: small file is returned untouched', () => {
  const r = truncateFullRead('a\nb\nc\n', 'x.ts');
  assert.equal(r.truncated, false);
  assert.equal(r.text, 'a\nb\nc\n');
  assert.equal(r.totalLines, 4);
});

test('truncateFullRead: a file over the line cap is truncated with a reread hint', () => {
  const content = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');
  const r = truncateFullRead(content, 'big.ts');
  assert.equal(r.truncated, true);
  assert.equal(r.shownLines, READ_FILE_MAX_LINES);
  assert.equal(r.totalLines, 1000);
  assert.match(r.text, /showing lines 1-600 of 1000/);
  assert.match(r.text, /400 more line\(s\)/);
  assert.match(r.text, /read_file\("big\.ts", startLine=601\)/);
  // The head content is present; the tail is not.
  assert.match(r.text, /^line 1\n/);
  assert.ok(!r.text.includes('line 999'));
});

test('truncateFullRead: char ceiling truncates a few enormous lines', () => {
  const content = ['x'.repeat(READ_FILE_MAX_CHARS + 5000), 'y'].join('\n');
  const r = truncateFullRead(content, 'huge.txt');
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= READ_FILE_MAX_CHARS + 400, 'capped near the char ceiling + notice');
  assert.match(r.text, /truncated/);
});

test('truncateFullRead: custom caps respected', () => {
  const content = Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n');
  const r = truncateFullRead(content, 'f', { maxLines: 5 });
  assert.equal(r.shownLines, 5);
  assert.equal(r.truncated, true);
  assert.match(r.text, /15 more line/);
});
