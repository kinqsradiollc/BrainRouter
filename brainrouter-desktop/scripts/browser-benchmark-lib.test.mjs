import assert from 'node:assert/strict';
import test from 'node:test';

import {
  booleanGate,
  finalizeReport,
  gate,
  parseHarnessArgs,
  percentile,
  ratio,
  summarize,
} from './browser-benchmark-lib.mjs';

test('summarize uses deterministic median and nearest-rank p95', () => {
  const samples = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.equal(percentile(samples, 0.95), 19);
  assert.deepEqual(summarize(samples), {
    count: 20,
    min: 1,
    median: 10.5,
    p95: 19,
    max: 20,
    samples,
  });
  assert.deepEqual(summarize([0.12349, 0.22349]).samples, [0.123, 0.223]);
});

test('gates fail real regressions and skip unavailable or disabled comparisons', () => {
  assert.equal(gate({ id: 'fast', description: 'fast', actual: 99, threshold: 100 }).status, 'pass');
  assert.equal(gate({ id: 'slow', description: 'slow', actual: 101, threshold: 100 }).status, 'fail');
  assert.equal(gate({ id: 'disabled', description: 'disabled', actual: 2, threshold: 1, enforce: false, reason: 'no stable runner' }).status, 'skip');
  assert.equal(gate({ id: 'missing', description: 'missing', actual: null, threshold: 1 }).status, 'skip');
  assert.equal(booleanGate({ id: 'state', description: 'state', passed: true }).status, 'pass');
  assert.equal(ratio(110, 100), 1.1);
  assert.equal(ratio(1, 0), null);
});

test('finalizeReport cannot report a failed gate as qualified', () => {
  const report = finalizeReport({
    kind: 'test',
    gates: [
      gate({ id: 'pass', description: 'pass', actual: 1, threshold: 2 }),
      gate({ id: 'fail', description: 'fail', actual: 3, threshold: 2 }),
      gate({ id: 'skip', description: 'skip', enforce: false, reason: 'unsupported' }),
    ],
  });
  assert.deepEqual(report.summary, { pass: 1, fail: 1, skip: 1, qualification: 'fail', fullyQualified: false });
});

test('a report with skipped gates is partial, never presented as qualified', () => {
  const report = finalizeReport({ gates: [
    { status: 'pass' },
    { status: 'skip' },
  ] });
  assert.deepEqual(report.summary, { pass: 1, fail: 0, skip: 1, qualification: 'partial', fullyQualified: false });
});

test('argument parsing validates bounds and stable-runner enforcement', () => {
  const parsed = parseHarnessArgs(['--runs', '25', '--switches', '2000', '--cycles', '200', '--max-tabs', '40', '--enforce-comparison']);
  assert.equal(parsed.runs, 25);
  assert.equal(parsed.switches, 2000);
  assert.equal(parsed.cycles, 200);
  assert.equal(parsed.maxTabs, 40);
  assert.equal(parsed.enforceComparison, true);
  assert.throws(() => parseHarnessArgs(['--runs', '0']), /1 to 200/);
  assert.throws(() => parseHarnessArgs(['--unknown']), /unknown argument/);
});
