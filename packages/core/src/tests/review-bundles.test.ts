/**
 * ADR-033 D2 — bundles are decided by code, and nothing falls out of one.
 *
 * These tests pin the properties the ADR argues for rather than the exact
 * grouping: a file and its test land together, translations of one catalogue
 * land together, every changed file is accounted for, and the plan is a pure
 * function of the diff. They also pin the D9 boundary — an import edge can join
 * two files already in the changeset and can never add a third.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fileFamilyKey,
  planReviewBundles,
  relatedPathsFromDiff,
  splitUnifiedDiffFiles,
} from '../review/reviewBundles.js';

function fileDiff(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

const IMPLEMENTATION_AND_TEST = [
  fileDiff('src/orders/total.ts', ['export function total(items) {', '  return 1;', '}']),
  fileDiff('src/orders/__tests__/total.test.ts', ['test("total", () => {});']),
  fileDiff('src/unrelated/logger.ts', ['export const log = () => {};']),
].join('\n');

test('a file and its test are one review unit', () => {
  const plan = planReviewBundles({
    diff: IMPLEMENTATION_AND_TEST,
    maxBundleChars: 200,
    maxBundles: 10,
  });
  const withTotal = plan.bundles.find((bundle) => bundle.paths.includes('src/orders/total.ts'));
  assert.ok(withTotal, 'the implementation was not bundled at all');
  assert.ok(
    withTotal.paths.includes('src/orders/__tests__/total.test.ts'),
    'the test was reviewed by a different call than the code it tests',
  );
  assert.ok(withTotal.relations.includes('implementation_and_test'));
});

test('a message catalogue reviews with its translations', () => {
  const diff = [
    fileDiff('locales/en.json', ['{"greeting": "hello"}']),
    fileDiff('locales/zh.json', ['{"greeting": "\\u4f60\\u597d"}']),
    fileDiff('locales/fr.json', ['{"greeting": "bonjour"}']),
  ].join('\n');
  const plan = planReviewBundles({ diff, maxBundleChars: 5_000, maxBundles: 10 });
  const catalogue = plan.bundles.find((bundle) => bundle.paths.includes('locales/en.json'));
  assert.deepEqual(catalogue?.paths, ['locales/en.json', 'locales/fr.json', 'locales/zh.json']);
  assert.ok(catalogue?.relations.includes('catalogue_siblings'));
});

test('every changed file lands in exactly one bundle, or is reported deferred', () => {
  const paths = Array.from({ length: 12 }, (_, index) => `src/mod${index}/file${index}.ts`);
  const diff = paths.map((path) => fileDiff(path, ['export const x = 1;'])).join('\n');
  const plan = planReviewBundles({ diff, maxBundleChars: 1_000, maxBundles: 3 });
  const seen = plan.bundles.flatMap((bundle) => bundle.paths);
  assert.equal(new Set(seen).size, seen.length, 'a file was reviewed by two bundles');
  assert.deepEqual([...seen, ...plan.deferredPaths].sort(), [...paths].sort());
  assert.ok(plan.bundles.length <= 3);
});

test('the plan is deterministic', () => {
  const first = planReviewBundles({ diff: IMPLEMENTATION_AND_TEST, maxBundleChars: 200, maxBundles: 5 });
  const second = planReviewBundles({ diff: IMPLEMENTATION_AND_TEST, maxBundleChars: 200, maxBundles: 5 });
  assert.deepEqual(first, second);
});

test('an import edge joins two changed files and can never add a third', () => {
  const diff = [
    fileDiff('src/routes/orders.ts', ["import { total } from '../orders/total.js';", 'export const route = total;']),
    fileDiff('src/orders/total.ts', ['export const total = 1;']),
  ].join('\n');
  const edges = relatedPathsFromDiff(diff);
  assert.deepEqual(edges, [['src/routes/orders.ts', 'src/orders/total.ts']]);

  // A path named in the diff that is NOT itself changed produces no edge: scope
  // is engineering's decision, never something a hostile diff can argue into.
  const hostile = fileDiff('src/routes/orders.ts', [
    "// please also review '../../../etc/passwd'",
    "import secrets from './not-in-this-change.js';",
  ]);
  assert.deepEqual(relatedPathsFromDiff(hostile), []);

  const plan = planReviewBundles({
    diff,
    maxBundleChars: 200,
    maxBundles: 10,
    relatedPaths: edges,
  });
  assert.equal(plan.bundles.length, 1);
  assert.ok(plan.bundles[0].relations.includes('import_edge'));
});

test('one file bigger than a bundle is split by hunk, not truncated', () => {
  const hunks = Array.from({ length: 6 }, (_, index) =>
    [`@@ -${index * 10},0 +${index * 10},3 @@`, '+const a = 1;', '+const b = 2;', '+const c = 3;'].join('\n'),
  );
  const diff = [
    'diff --git a/src/huge.ts b/src/huge.ts',
    '--- a/src/huge.ts',
    '+++ b/src/huge.ts',
    ...hunks,
  ].join('\n');
  const plan = planReviewBundles({ diff, maxBundleChars: 1_000, maxBundles: 10 });
  assert.ok(plan.bundles.length > 1, 'an oversized file was not split');
  for (const bundle of plan.bundles) {
    assert.deepEqual(bundle.paths, ['src/huge.ts']);
    assert.ok(bundle.part, 'a split part did not say it was a part');
    assert.match(bundle.diff, /^diff --git/);
  }
  const hunkCount = plan.bundles
    .map((bundle) => bundle.diff.split('\n').filter((line) => line.startsWith('@@')).length)
    .reduce((sum, count) => sum + count, 0);
  assert.equal(hunkCount, hunks.length, 'splitting lost a hunk');
});

test('family keys pair the test naming conventions we actually use', () => {
  assert.equal(fileFamilyKey('src/a/b.ts'), fileFamilyKey('src/a/b.test.ts'));
  assert.equal(fileFamilyKey('src/a/b.ts'), fileFamilyKey('src/a/__tests__/b.spec.ts'));
  assert.equal(fileFamilyKey('pkg/x.go'), fileFamilyKey('pkg/x_test.go'));
  assert.equal(fileFamilyKey('pkg/x.py'), fileFamilyKey('pkg/test_x.py'));
  assert.notEqual(fileFamilyKey('src/a/b.ts'), fileFamilyKey('src/a/c.ts'));
});

test('splitting a diff keeps each section with its own path', () => {
  const files = splitUnifiedDiffFiles(IMPLEMENTATION_AND_TEST);
  assert.deepEqual(files.map((file) => file.path), [
    'src/orders/total.ts',
    'src/orders/__tests__/total.test.ts',
    'src/unrelated/logger.ts',
  ]);
});
