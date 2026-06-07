import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeModelArtifacts } from '../runtime/outputSanitize.js';

test('POLISH-2 sanitizeModelArtifacts: restores the colon in garbled file:line citations', () => {
  assert.equal(sanitizeModelArtifacts('See src/api/auth.ts*#COLON|*42 for the bug.'), 'See src/api/auth.ts:42 for the bug.');
  // variant forms
  assert.equal(sanitizeModelArtifacts('foo.ts#COLON|10'), 'foo.ts:10');
  assert.equal(sanitizeModelArtifacts('foo.ts*#COLON*10'), 'foo.ts:10');
  assert.equal(sanitizeModelArtifacts('foo.ts#COLON10'), 'foo.ts:10');
});

test('POLISH-2 sanitizeModelArtifacts: handles multiple occurrences', () => {
  assert.equal(
    sanitizeModelArtifacts('a.ts*#COLON|*1 and b.ts*#COLON|*2'),
    'a.ts:1 and b.ts:2',
  );
});

test('POLISH-2 sanitizeModelArtifacts: leaves normal text untouched', () => {
  const clean = 'The ratio is 3:1 and the file is src/x.ts:99.';
  assert.equal(sanitizeModelArtifacts(clean), clean);
  assert.equal(sanitizeModelArtifacts(''), '');
});
