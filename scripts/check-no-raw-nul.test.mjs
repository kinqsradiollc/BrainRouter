/**
 * Purpose: Prove the raw-NUL gate flags a literal 0x00 byte with its position,
 * accepts the `\0` escape, scopes itself to text files, and passes on the
 * current tree.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  checkNoRawNulBytes,
  findRawNulBytes,
  formatViolation,
  isTextSourcePath,
  listTrackedTextFiles,
} from './check-no-raw-nul.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('no tracked text file in the repository contains a raw NUL byte', () => {
  assert.deepEqual(checkNoRawNulBytes(repoRoot).map(formatViolation), []);
});

test('a literal 0x00 byte is reported with its 1-based line and byte column', () => {
  const source = Buffer.concat([
    Buffer.from('const a = 1;\nconst key = `${name}', 'utf8'),
    Buffer.from([0x00]),
    Buffer.from('${args}`;\n', 'utf8'),
  ]);
  const hits = findRawNulBytes(source);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].column, 'const key = `${name}'.length + 1);
  assert.match(hits[0].context, /\$\{name\}<NUL>\$\{args\}/);
});

test('the \\0 escape sequence is source text, not a NUL byte', () => {
  const escaped = Buffer.from("const key = `${a}\\0${b}`;\nparts.join('\\0');\n", 'utf8');
  assert.deepEqual(findRawNulBytes(escaped), []);
});

test('every NUL is reported when a line carries more than one', () => {
  const source = Buffer.concat([Buffer.from('x'), Buffer.from([0x00]), Buffer.from('y'), Buffer.from([0x00])]);
  assert.deepEqual(
    findRawNulBytes(source).map(({ line, column }) => ({ line, column })),
    [
      { line: 1, column: 2 },
      { line: 1, column: 4 },
    ],
  );
});

test('binary assets are outside the gate; source and docs are inside it', () => {
  assert.equal(isTextSourcePath('presentation/deck.pptx'), false);
  assert.equal(isTextSourcePath('assets/icon.png'), false);
  assert.equal(isTextSourcePath('packages/core/src/index.ts'), true);
  assert.equal(isTextSourcePath('brainrouter-desktop/electron/main.mts'), true);
  assert.equal(isTextSourcePath('brainrouter-rules/README.md'), true);
  const tracked = listTrackedTextFiles(repoRoot);
  assert.ok(tracked.includes('package.json'));
  assert.ok(tracked.every((file) => isTextSourcePath(file)));
});

test('an explicit file list is scanned in place of the tracked set', () => {
  assert.deepEqual(checkNoRawNulBytes(repoRoot, ['package.json', 'scripts/check-no-raw-nul.mjs']), []);
});
