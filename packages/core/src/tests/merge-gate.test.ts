import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePatchFiles, findCrossWorktreeOverlaps, planSynthesisMerge } from '../orchestration/mergeGate.js';

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1 @@
+added
`;

test('BUILD-LOOP P2.5 parsePatchFiles extracts the files a patch touches', () => {
  assert.deepEqual(parsePatchFiles(PATCH).sort(), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(parsePatchFiles(''), []);
  assert.deepEqual(parsePatchFiles('not a patch'), []);
});

test('BUILD-LOOP P2.5 findCrossWorktreeOverlaps flags files touched by >1 worktree', () => {
  const overlaps = findCrossWorktreeOverlaps([
    { id: 's1', files: ['src/a.ts', 'src/shared.ts'] },
    { id: 's2', files: ['src/b.ts', 'src/shared.ts'] },
    { id: 's3', files: ['src/c.ts'] },
  ]);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].file, 'src/shared.ts');
  assert.deepEqual(overlaps[0].ids.sort(), ['s1', 's2']);
});

test('BUILD-LOOP P2.5 planSynthesisMerge: non-overlapping slices all merge', () => {
  const plan = planSynthesisMerge([
    { id: 's1', files: ['src/a.ts'] },
    { id: 's2', files: ['src/b.ts'] },
  ]);
  assert.deepEqual(plan.merge, ['s1', 's2']);
  assert.deepEqual(plan.hold, []);
  assert.deepEqual(plan.overlaps, []);
});

test('BUILD-LOOP P2.5 planSynthesisMerge: first writer wins, later overlapper held', () => {
  const plan = planSynthesisMerge([
    { id: 's1', files: ['src/shared.ts', 'src/a.ts'] },
    { id: 's2', files: ['src/shared.ts'] }, // overlaps s1
    { id: 's3', files: ['src/c.ts'] },
  ]);
  assert.deepEqual(plan.merge, ['s1', 's3'], 's1 (first) + s3 (disjoint) merge');
  assert.equal(plan.hold.length, 1);
  assert.equal(plan.hold[0].id, 's2');
  assert.match(plan.hold[0].reason, /overlaps.*src\/shared\.ts.*s1/);
});

test('BUILD-LOOP P2.5 planSynthesisMerge: a synthesis blocker holds EVERY slice', () => {
  const plan = planSynthesisMerge(
    [{ id: 's1', files: ['src/a.ts'] }, { id: 's2', files: ['src/b.ts'] }],
    { synthesisBlocker: true },
  );
  assert.deepEqual(plan.merge, []);
  assert.equal(plan.hold.length, 2);
  assert.match(plan.hold[0].reason, /blocker/i);
});
