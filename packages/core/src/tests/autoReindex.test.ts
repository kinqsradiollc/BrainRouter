import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fileExtension,
  isReindexableFile,
  languageHint,
  reindexSignature,
  shouldReindex,
  type ReindexGate,
} from '../util/autoReindex.js';

// --- extension + language --------------------------------------------------

test('fileExtension lowercases and ignores dotfiles/dirs', () => {
  assert.equal(fileExtension('src/agent/Agent.TS'), 'ts');
  assert.equal(fileExtension('/abs/path/foo.py'), 'py');
  assert.equal(fileExtension('Makefile'), '');
  assert.equal(fileExtension('.gitignore'), ''); // leading dot only, no real ext
  assert.equal(fileExtension('a.b.tar.gz'), 'gz');
});

test('isReindexableFile gates to the code allowlist', () => {
  for (const f of ['x.ts', 'x.tsx', 'x.py', 'x.rs', 'x.go', 'x.json', 'x.sql']) {
    assert.equal(isReindexableFile(f), true, f);
  }
  for (const f of ['x.png', 'x.lock', 'package-lock.json'.replace('.json', '.lockb'), 'x.pdf', 'README']) {
    assert.equal(isReindexableFile(f), false, f);
  }
});

test('languageHint is the bare extension', () => {
  assert.equal(languageHint('foo/bar.tsx'), 'tsx');
  assert.equal(languageHint('foo'), '');
});

// --- signature -------------------------------------------------------------

test('reindexSignature changes iff size or mtime changes', () => {
  const a = reindexSignature({ size: 100, mtimeMs: 1000.4 });
  assert.equal(a, reindexSignature({ size: 100, mtimeMs: 1000.4 }));
  assert.notEqual(a, reindexSignature({ size: 101, mtimeMs: 1000.4 }));
  assert.notEqual(a, reindexSignature({ size: 100, mtimeMs: 2000 }));
  // sub-millisecond jitter is rounded away so it doesn't churn
  assert.equal(reindexSignature({ size: 100, mtimeMs: 1000.4 }), reindexSignature({ size: 100, mtimeMs: 1000.1 }));
});

// --- gate ------------------------------------------------------------------

const base: ReindexGate = {
  enabled: true,
  connected: true,
  filePath: 'src/x.ts',
  signature: 'sig-1',
  lastSignature: undefined,
};

test('shouldReindex fires for a fresh code file when enabled + connected', () => {
  assert.equal(shouldReindex(base), true);
});

test('shouldReindex skips when disabled or offline', () => {
  assert.equal(shouldReindex({ ...base, enabled: false }), false);
  assert.equal(shouldReindex({ ...base, connected: false }), false);
});

test('shouldReindex skips non-code files', () => {
  assert.equal(shouldReindex({ ...base, filePath: 'assets/logo.png' }), false);
});

test('shouldReindex skips unchanged content (signature match)', () => {
  assert.equal(shouldReindex({ ...base, lastSignature: 'sig-1' }), false);
  assert.equal(shouldReindex({ ...base, lastSignature: 'sig-0' }), true);
});
