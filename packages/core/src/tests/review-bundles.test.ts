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
    // Budget large enough to hold the pair. It has to be: the budget is a hard
    // constraint now (a group over it is split however related its files are),
    // so a budget too small to hold two files would be testing the splitter
    // rather than the pairing this test is about.
    maxBundleChars: 5_000,
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

test('unrelated files are never size-packed into one review unit', () => {
  const diff = [
    fileDiff('src/orders/create.ts', ['export const create = () => 1;']),
    fileDiff('src/orders/logger.ts', ['export const log = () => 2;']),
  ].join('\n');
  const plan = planReviewBundles({ diff, maxBundleChars: 50_000, maxBundles: 10 });
  assert.equal(plan.bundles.length, 2, 'spare character budget merged unrelated semantic units');
  assert.deepEqual(
    plan.bundles.map((bundle) => bundle.paths),
    [['src/orders/create.ts'], ['src/orders/logger.ts']],
  );
  assert.ok(plan.bundles.every((bundle) => !bundle.relations.includes('directory_adjacency')));
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
    // Same reason as the pairing test: big enough that the budget is not what
    // decides the outcome, so this measures the import edge.
    maxBundleChars: 5_000,
    maxBundles: 10,
    relatedPaths: edges,
  });
  assert.equal(plan.bundles.length, 1);
  assert.ok(plan.bundles[0].relations.includes('import_edge'));
});

test('changed workflow and package scripts join only the changed files they invoke', () => {
  const diff = [
    fileDiff('.github/workflows/release.yml', [
      'jobs:',
      '  package:',
      '    steps:',
      '      - run: node brainrouter-desktop/build/package-app.mjs',
      '      - run: node scripts/not-in-this-change.mjs',
    ]),
    fileDiff('brainrouter-desktop/build/package-app.mjs', ['export const packageApp = true;']),
    fileDiff('brainrouter/package.json', [
      '  "scripts": {',
      '    "bench:summary": "npx tsx benchmark/bench-summary.ts"',
      '  }',
    ]),
    fileDiff('brainrouter/benchmark/bench-summary.ts', ['export const summarize = true;']),
    fileDiff('src/unrelated.ts', ['export const unrelated = true;']),
  ].join('\n');

  const edges = relatedPathsFromDiff(diff);
  assert.deepEqual(edges, [
    ['.github/workflows/release.yml', 'brainrouter-desktop/build/package-app.mjs'],
    ['brainrouter/package.json', 'brainrouter/benchmark/bench-summary.ts'],
  ]);

  const plan = planReviewBundles({ diff, maxBundleChars: 50_000, maxBundles: 10, relatedPaths: edges });
  assert.deepEqual(
    plan.bundles.map((bundle) => bundle.paths),
    [
      ['.github/workflows/release.yml', 'brainrouter-desktop/build/package-app.mjs'],
      ['brainrouter/benchmark/bench-summary.ts', 'brainrouter/package.json'],
      ['src/unrelated.ts'],
    ],
  );
});

test('changed HTML and CSS assets form bounded semantic review units', () => {
  const diff = [
    fileDiff('web/index.html', [
      '<link rel="stylesheet" href="./styles/app.css">',
      '<script type="module" src="./src/main.ts"></script>',
      '<script src="https://example.invalid/not-reviewable.js"></script>',
    ]),
    fileDiff('web/styles/app.css', [
      '@import "./theme.css";',
      '.logo { background: url("../assets/logo.svg"); }',
    ]),
    fileDiff('web/styles/theme.css', [':root { color: black; }']),
    fileDiff('web/src/main.ts', ['import "../styles/app.css";', 'export const main = true;']),
    fileDiff('web/assets/logo.svg', ['<svg></svg>']),
    fileDiff('web/assets/unreferenced.svg', ['<svg></svg>']),
  ].join('\n');

  const edges = relatedPathsFromDiff(diff);
  assert.deepEqual(edges, [
    ['web/index.html', 'web/styles/app.css'],
    ['web/index.html', 'web/src/main.ts'],
    ['web/styles/app.css', 'web/styles/theme.css'],
    ['web/styles/app.css', 'web/assets/logo.svg'],
    ['web/src/main.ts', 'web/styles/app.css'],
  ]);
  const plan = planReviewBundles({ diff, maxBundleChars: 50_000, maxBundles: 10, relatedPaths: edges });
  assert.deepEqual(plan.bundles[0].paths, [
    'web/assets/logo.svg',
    'web/index.html',
    'web/src/main.ts',
    'web/styles/app.css',
    'web/styles/theme.css',
  ]);
  assert.deepEqual(plan.bundles[1].paths, ['web/assets/unreferenced.svg']);
});

test('changed package locks and conventional cross-directory tests join without fuzzy basename packing', () => {
  const diff = [
    fileDiff('package-lock.json', ['{"lockfileVersion": 3}']),
    fileDiff('packages/widget/package.json', ['{"name": "@example/widget"}']),
    fileDiff('packages/widget/tests/format.test.ts', ['test("format", () => {});']),
    fileDiff('packages/widget/src/format.ts', ['export const format = true;']),
    fileDiff('packages/other/src/format.ts', ['export const unrelatedSameName = true;']),
  ].join('\n');

  const edges = relatedPathsFromDiff(diff);
  assert.deepEqual(edges, [
    ['packages/widget/package.json', 'package-lock.json'],
    ['packages/widget/tests/format.test.ts', 'packages/widget/src/format.ts'],
  ]);
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
  const plan = planReviewBundles({ diff, maxBundleChars: 200, maxBundles: 10 });
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

test('the budget is a budget: a related GROUP too large is split too', () => {
  // The regression this pins: the split only fired for a group of ONE, so a
  // connected component of many related files was emitted whole. Measured on
  // real pull requests, 27 of 102 bundles blew the production cap and one
  // component produced a single 5 MB prompt — 87× the budget. That is a
  // context-limit failure, and the coverage it costs is invisible.
  // Each file fits on its own; the PAIR does not. That is the shape the old
  // code emitted whole, and the shape a hunk split cannot rescue.
  const body = Array.from({ length: 100 }, (_, index) => `const value${index} = ${index};`);
  const diff = [
    fileDiff('src/orders/total.ts', body),
    fileDiff('src/orders/total.test.ts', body), // same family — one group
  ].join('\n');
  const maxBundleChars = 3_500;
  const plan = planReviewBundles({ diff, maxBundleChars, maxBundles: 40 });
  assert.ok(plan.bundles.length > 1, 'an oversized related group was emitted as one bundle');
  for (const bundle of plan.bundles) {
    assert.ok(
      bundle.diff.length <= maxBundleChars,
      `bundle ${bundle.id} is ${bundle.diff.length} chars, over the ${maxBundleChars} budget`,
    );
  }
  // Nothing is lost by splitting: both files are still reviewed.
  const covered = new Set(plan.bundles.flatMap((bundle) => bundle.paths));
  assert.deepEqual([...covered].sort(), ['src/orders/total.test.ts', 'src/orders/total.ts']);
});

test('every bundle of a many-file changeset stays inside the budget', () => {
  // The same property stated over a wider shape, so a future grouping rule that
  // joins more files cannot quietly reintroduce an unbounded bundle.
  const body = Array.from({ length: 60 }, (_, index) => `const v${index} = ${index};`);
  const diff = Array.from({ length: 30 }, (_, index) =>
    fileDiff(`src/area/mod${index}.ts`, body),
  ).join('\n');
  const maxBundleChars = 4_000;
  const plan = planReviewBundles({
    diff,
    maxBundleChars,
    maxBundles: 100,
    // Join everything to everything: the worst case for a size budget.
    relatedPaths: Array.from({ length: 29 }, (_, index) =>
      [`src/area/mod0.ts`, `src/area/mod${index + 1}.ts`] as [string, string],
    ),
  });
  for (const bundle of plan.bundles) {
    assert.ok(
      bundle.diff.length <= maxBundleChars,
      `bundle ${bundle.id} is ${bundle.diff.length} chars, over the ${maxBundleChars} budget`,
    );
  }
  const covered = new Set(plan.bundles.flatMap((bundle) => bundle.paths));
  assert.equal(covered.size + plan.deferredPaths.length, 30);
});

test('a single enormous HUNK is cut up too, with honest line numbers on each piece', () => {
  // A newly-added generated file is one hunk holding its whole content, so
  // "split by hunk" left it exactly as oversized as it started. Five bundles
  // across the committed benchmark set were still over the production cap this
  // way, the worst at 256 KB — a context-limit failure wearing a budget's name.
  const body = Array.from({ length: 300 }, (_, index) => `+const generated${index} = ${index};`);
  const diff = [
    'diff --git a/src/generated.ts b/src/generated.ts',
    '--- /dev/null',
    '+++ b/src/generated.ts',
    `@@ -0,0 +1,${body.length} @@`,
    ...body,
  ].join('\n');
  const maxBundleChars = 3_000;
  const plan = planReviewBundles({ diff, maxBundleChars, maxBundles: 100 });
  assert.ok(plan.bundles.length > 1, 'a single oversized hunk was not split');
  for (const bundle of plan.bundles) {
    assert.ok(
      bundle.diff.length <= maxBundleChars,
      `bundle ${bundle.id} is ${bundle.diff.length} chars, over the ${maxBundleChars} budget`,
    );
    assert.match(bundle.diff, /^diff --git/, 'a piece lost the file header');
    assert.ok(bundle.part, 'a split part did not say it was a part');
  }
  // Nothing is lost, and the recomputed headers are honest: reading every piece
  // in order reproduces the file's added lines exactly once, in order.
  const added = plan.bundles.flatMap((bundle) =>
    bundle.diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')),
  );
  assert.deepEqual(added, body);
  // Each piece's `@@` header must name the line its first added line really is.
  let expectedNew = 1;
  for (const bundle of plan.bundles) {
    const marker = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/m.exec(bundle.diff);
    assert.ok(marker, 'a piece lost its hunk header');
    assert.equal(Number(marker[1]), expectedNew, `piece ${bundle.id} claims the wrong start line`);
    expectedNew += bundle.diff.split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  }
});

test('family keys pair the test naming conventions we actually use', () => {
  assert.equal(fileFamilyKey('src/a/b.ts'), fileFamilyKey('src/a/b.test.ts'));
  assert.equal(fileFamilyKey('src/a/b.ts'), fileFamilyKey('src/a/__tests__/b.spec.ts'));
  assert.equal(fileFamilyKey('pkg/x.go'), fileFamilyKey('pkg/x_test.go'));
  assert.equal(fileFamilyKey('pkg/x.py'), fileFamilyKey('pkg/test_x.py'));
  assert.notEqual(fileFamilyKey('src/a/b.ts'), fileFamilyKey('src/a/c.ts'));
});

test('cross-directory test relationships preserve non-TypeScript implementation extensions', () => {
  const diff = [
    fileDiff('packages/widget/tests/format.spec.js', ['test("format", () => {});']),
    fileDiff('packages/widget/src/format.js', ['export const format = true;']),
    fileDiff('services/jobs/tests/worker_test.go', ['func TestWorker(t *testing.T) {}']),
    fileDiff('services/jobs/src/worker.go', ['func Worker() {}']),
  ].join('\n');
  assert.deepEqual(relatedPathsFromDiff(diff), [
    ['packages/widget/tests/format.spec.js', 'packages/widget/src/format.js'],
    ['services/jobs/tests/worker_test.go', 'services/jobs/src/worker.go'],
  ]);
});

test('local Markdown links join changed documentation and scripts without widening scope', () => {
  const diff = [
    fileDiff('CHANGELOG.md', [
      '[Release notes](brainrouter-changelog/0.4.1.md)',
      '[External](https://example.invalid/not-reviewable.md)',
    ]),
    fileDiff('brainrouter-changelog/README.md', ['[0.4.1](0.4.1.md)']),
    fileDiff('brainrouter-changelog/0.4.1.md', ['# 0.4.1']),
    fileDiff('desktop/build/PACKAGING.md', ['[helper](./dereference-workspace-deps.mjs)']),
    fileDiff('desktop/build/dereference-workspace-deps.mjs', ['export const dereference = true;']),
    fileDiff('docs/unrelated.md', ['[Absent](../src/not-in-this-change.ts)']),
  ].join('\n');

  assert.deepEqual(relatedPathsFromDiff(diff), [
    ['CHANGELOG.md', 'brainrouter-changelog/0.4.1.md'],
    ['brainrouter-changelog/README.md', 'brainrouter-changelog/0.4.1.md'],
    ['desktop/build/PACKAGING.md', 'desktop/build/dereference-workspace-deps.mjs'],
  ]);
});

test('exact CSS, dependency, config, entry, and protocol contracts join their changed endpoints', () => {
  const diff = [
    fileDiff('desktop/package.json', [
      '"dependencies": {',
      '  "@monaco-editor/react": "^4.7.0",',
      '  "monaco-editor": "^0.55.1"',
      '}',
    ]),
    fileDiff('package-lock.json', ['{"lockfileVersion": 3}']),
    fileDiff('desktop/vite.config.ts', [
      '// worker imports live in src/lib/editor/monacoEnv.ts',
      "export default { optimizeDeps: { include: ['monaco-editor'] } };",
    ]),
    fileDiff('desktop/index.html', ['<meta http-equiv="Content-Security-Policy" content="worker-src self">']),
    fileDiff('desktop/src/lib/editor/monacoEnv.ts', ["import * as monaco from 'monaco-editor';"]),
    fileDiff('desktop/src/panels/EditorPanel.tsx', [
      "import Editor from '@monaco-editor/react';",
      'export const Panel = () => <div className={`editor-tab${true ? \' active\' : \'\'}`} />;',
    ]),
    fileDiff('desktop/src/theme.css', ['.editor-tab.active { color: red; }']),
    fileDiff('desktop/src/App.tsx', ["send({ kind: 'set-model', model });"]),
    fileDiff('desktop/electron/hostCore.ts', ["case 'set-model': return;", "case 'status': return;"]),
    fileDiff('desktop/src/unrelated.tsx', ['export const Other = () => <div className="other" />;']),
  ].join('\n');

  const edges = relatedPathsFromDiff(diff);
  assert.ok(edges.some(([from, to]) => from === 'desktop/package.json' && to === 'package-lock.json'));
  assert.ok(edges.some(([from, to]) => from === 'desktop/vite.config.ts' && to === 'desktop/src/lib/editor/monacoEnv.ts'));
  assert.ok(edges.some(([from, to]) => from === 'desktop/vite.config.ts' && to === 'desktop/index.html'));
  assert.ok(edges.some(([from, to]) => from === 'desktop/src/theme.css' && to === 'desktop/src/panels/EditorPanel.tsx'));
  assert.ok(edges.some(([from, to]) => from === 'desktop/src/App.tsx' && to === 'desktop/electron/hostCore.ts'));
  assert.ok(edges.some(([from, to]) => from === 'desktop/package.json' && to === 'desktop/src/lib/editor/monacoEnv.ts'));
  assert.ok(edges.some(([from, to]) => from === 'desktop/package.json' && to === 'desktop/src/panels/EditorPanel.tsx'));
  assert.ok(!edges.some(([from, to]) => from.includes('unrelated') || to.includes('unrelated')));
});

test('splitting a diff keeps each section with its own path', () => {
  const files = splitUnifiedDiffFiles(IMPLEMENTATION_AND_TEST);
  assert.deepEqual(files.map((file) => file.path), [
    'src/orders/total.ts',
    'src/orders/__tests__/total.test.ts',
    'src/unrelated/logger.ts',
  ]);
});
