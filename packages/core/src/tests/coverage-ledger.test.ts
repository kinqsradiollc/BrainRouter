/**
 * ADR-027 D9.1 (P6-5) — the coverage denominator.
 *
 * The invariant: every in-scope path lands in exactly one bucket, and a gap is
 * stated in words. Silence about what was missed reads as "covered everything",
 * which is how a reviewer quietly stops covering a directory and nobody notices.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCoverageReport,
  describeCoverage,
  DEFAULT_EXCLUSIONS,
  type ExclusionRule,
} from '../review/coverageLedger.js';

test('every in-scope path lands in exactly one bucket', () => {
  const inventory = ['src/a.ts', 'src/b.ts', 'package-lock.json', 'src/c.ts'];
  const report = buildCoverageReport({ inventory, reviewed: ['src/a.ts'] });

  const accounted = [
    ...report.reviewed,
    ...report.excluded.map((f) => f.path),
    ...report.unreviewed,
  ].sort();
  assert.deepEqual(accounted, [...inventory].sort(), 'nothing may be silently dropped');
  assert.equal(report.total, 4);
});

test('an unreviewed file is reported, not folded into a percentage', () => {
  const report = buildCoverageReport({
    inventory: ['src/a.ts', 'src/b.ts'],
    reviewed: ['src/a.ts'],
  });
  assert.deepEqual(report.unreviewed, ['src/b.ts']);
  assert.equal(report.complete, false);
  assert.match(describeCoverage(report), /NOT reviewed/);
  assert.match(describeCoverage(report), /src\/b\.ts/, 'name the gap, do not just count it');
});

test('exclusions do not spoil completeness, but must carry a named rule', () => {
  const report = buildCoverageReport({
    inventory: ['src/a.ts', 'package-lock.json', 'dist/bundle.js'],
    reviewed: ['src/a.ts'],
  });
  assert.equal(report.complete, true, 'a deliberately excluded file is not a gap');
  assert.equal(report.unreviewed.length, 0);
  assert.deepEqual(report.excluded.map((f) => f.ruleId).sort(), ['generated', 'lockfile']);
  for (const file of report.excluded) {
    assert.ok(file.reason.length > 0, 'an exclusion without a stated reason is an oversight');
  }
});

test('a reviewed file beats an exclusion rule that also matches it', () => {
  // If the model actually looked at a generated file, that is a fact worth
  // recording — reporting it as "skipped" would misdescribe the run.
  const report = buildCoverageReport({
    inventory: ['dist/bundle.js'],
    reviewed: ['dist/bundle.js'],
  });
  assert.deepEqual(report.reviewed, ['dist/bundle.js']);
  assert.equal(report.excluded.length, 0);
});

test('a cited path outside the inventory is surfaced, not ignored', () => {
  // Usually a hallucinated or stale path. A review citing files that are not in
  // this revision is reporting on something other than this revision.
  const report = buildCoverageReport({
    inventory: ['src/a.ts'],
    reviewed: ['src/a.ts', 'src/imaginary.ts'],
  });
  assert.deepEqual(report.outOfScope, ['src/imaginary.ts']);
  assert.match(describeCoverage(report), /not in this revision/);
});

test('duplicates in the inventory do not inflate the denominator', () => {
  const report = buildCoverageReport({
    inventory: ['src/a.ts', 'src/a.ts', 'src/b.ts'],
    reviewed: ['src/a.ts', 'src/a.ts'],
  });
  assert.equal(report.total, 2);
  assert.deepEqual(report.reviewed, ['src/a.ts']);
  assert.deepEqual(report.unreviewed, ['src/b.ts']);
});

test('the default rules catch lockfiles, generated output, binaries, and vendored code', () => {
  const inventory = [
    'pnpm-lock.yaml', 'go.sum',
    'dist/app.js', 'src/x.min.js', 'coverage/report.html',
    'assets/logo.png', 'fonts/Inter.woff2',
    'vendor/lib/thing.go', 'third_party/dep.c',
  ];
  const report = buildCoverageReport({ inventory, reviewed: [] });
  assert.equal(report.unreviewed.length, 0, 'all of these should be claimed by a rule');
  assert.equal(report.complete, true);
  const rules = new Set(report.excluded.map((f) => f.ruleId));
  assert.deepEqual([...rules].sort(), ['binary', 'generated', 'lockfile', 'vendored']);
});

test('ordinary source is never excluded by the defaults', () => {
  const inventory = ['src/auth.ts', 'lib/parser.py', 'app/main.go', 'README.md'];
  const report = buildCoverageReport({ inventory, reviewed: [] });
  assert.equal(report.excluded.length, 0);
  assert.deepEqual(report.unreviewed, [...inventory].sort());
  assert.equal(report.complete, false);
});

test('custom rules replace the defaults rather than adding to them', () => {
  // Explicit substitution: a caller narrowing the policy must not silently
  // inherit exclusions it did not ask for.
  const onlyDocs: ExclusionRule[] = [
    { id: 'docs', reason: 'Prose, reviewed separately.', matches: (p) => p.endsWith('.md') },
  ];
  const report = buildCoverageReport({
    inventory: ['README.md', 'package-lock.json'],
    reviewed: [],
    exclusions: onlyDocs,
  });
  assert.deepEqual(report.excluded.map((f) => f.ruleId), ['docs']);
  assert.deepEqual(report.unreviewed, ['package-lock.json'], 'the default lockfile rule no longer applies');
});

test('an empty inventory says so plainly', () => {
  const report = buildCoverageReport({ inventory: [], reviewed: [] });
  assert.equal(report.total, 0);
  assert.equal(report.complete, true);
  assert.match(describeCoverage(report), /No files were in scope/);
});

test('a fully reviewed run reads as complete without caveats', () => {
  const report = buildCoverageReport({
    inventory: ['src/a.ts', 'src/b.ts'],
    reviewed: ['src/a.ts', 'src/b.ts'],
  });
  assert.equal(report.complete, true);
  const text = describeCoverage(report);
  assert.match(text, /2\/2/);
  assert.doesNotMatch(text, /NOT reviewed/);
});

test('the default rule set is non-empty and every rule states a reason', () => {
  assert.ok(DEFAULT_EXCLUSIONS.length > 0);
  for (const rule of DEFAULT_EXCLUSIONS) {
    assert.ok(rule.id.length > 0);
    assert.ok(rule.reason.length > 10, `rule ${rule.id} needs a real justification`);
  }
});
