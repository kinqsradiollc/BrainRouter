import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  pathWithinOwnership,
  ownershipRequirementError,
  ownershipWriteViolation,
} from '../orchestration/ownership.js';

test('pathWithinOwnership: ** matches nested paths under the prefix', () => {
  assert.equal(pathWithinOwnership('src/payments/**', 'src/payments/api.ts'), true);
  assert.equal(pathWithinOwnership('src/payments/**', 'src/payments/deep/nested/x.ts'), true);
  assert.equal(pathWithinOwnership('src/payments/**', 'src/billing/api.ts'), false);
  assert.equal(pathWithinOwnership('src/payments/**', 'README.md'), false);
});

test('pathWithinOwnership: * stays within a single segment', () => {
  assert.equal(pathWithinOwnership('src/*.ts', 'src/index.ts'), true);
  assert.equal(pathWithinOwnership('src/*.ts', 'src/sub/index.ts'), false);
});

test('pathWithinOwnership: leading **/ matches at any depth', () => {
  assert.equal(pathWithinOwnership('**/types.ts', 'types.ts'), true);
  assert.equal(pathWithinOwnership('**/types.ts', 'a/b/types.ts'), true);
  assert.equal(pathWithinOwnership('**/types.ts', 'a/b/other.ts'), false);
});

test('pathWithinOwnership: normalizes ./ and backslashes', () => {
  assert.equal(pathWithinOwnership('src/owned/**', './src/owned/a.ts'), true);
  assert.equal(pathWithinOwnership('src/owned/**', 'src\\owned\\a.ts'), true);
});

test('ownershipRequirementError: write/shell without ownership is rejected', () => {
  assert.match(ownershipRequirementError('write', null, false) ?? '', /must declare an "ownership"/);
  assert.match(ownershipRequirementError('shell', undefined, false) ?? '', /must declare an "ownership"/);
  assert.match(ownershipRequirementError('write', '   ', false) ?? '', /must declare an "ownership"/);
});

test('ownershipRequirementError: read access never requires ownership', () => {
  assert.equal(ownershipRequirementError('read', null, false), null);
});

test('ownershipRequirementError: ownership present, or allowOverlap, passes', () => {
  assert.equal(ownershipRequirementError('write', 'src/x/**', false), null);
  assert.equal(ownershipRequirementError('write', null, true), null);
  assert.equal(ownershipRequirementError('shell', undefined, true), null);
});

test('ownershipWriteViolation: in-bounds write allowed, out-of-bounds refused', () => {
  const ws = '/repo';
  assert.equal(
    ownershipWriteViolation('src/owned/**', ws, path.join(ws, 'src/owned/a.ts')),
    null,
  );
  assert.match(
    ownershipWriteViolation('src/owned/**', ws, path.join(ws, 'src/other/b.ts')) ?? '',
    /outside this agent's ownership boundary "src\/owned\/\*\*"/,
  );
});

test('ownershipWriteViolation: no ownership set => never blocks', () => {
  const ws = '/repo';
  assert.equal(ownershipWriteViolation(null, ws, path.join(ws, 'anything.ts')), null);
  assert.equal(ownershipWriteViolation('', ws, path.join(ws, 'anything.ts')), null);
});
