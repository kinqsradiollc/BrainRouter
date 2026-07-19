import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPORT_SCHEMA_VERSION = 1;

function finiteSamples(samples) {
  if (!Array.isArray(samples)) return [];
  return samples.map(Number).filter(Number.isFinite);
}

export function percentile(samples, quantile) {
  const sorted = finiteSamples(samples).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const q = Math.min(1, Math.max(0, Number(quantile)));
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

export function summarize(samples, { includeSamples = true } = {}) {
  const values = finiteSamples(samples);
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  const result = {
    count: sorted.length,
    min: round(sorted[0]),
    median: round(median),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1)),
  };
  if (includeSamples) result.samples = sorted.map((value) => round(value));
  return result;
}

export function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return round(numerator / denominator, 4);
}

export function gate({ id, description, actual = null, threshold = null, operator = '<=', unit = '', enforce = true, reason = '' }) {
  if (!enforce) {
    return { id, description, status: 'skip', actual, threshold, operator, unit, reason: reason || 'gate is not enabled on this runner' };
  }
  if (!Number.isFinite(actual) || !Number.isFinite(threshold)) {
    return { id, description, status: 'skip', actual, threshold, operator, unit, reason: reason || 'measurement is unavailable' };
  }
  const passed = operator === '<='
    ? actual <= threshold
    : operator === '>='
      ? actual >= threshold
      : operator === '=='
        ? actual === threshold
        : false;
  return { id, description, status: passed ? 'pass' : 'fail', actual: round(actual), threshold, operator, unit };
}

export function booleanGate({ id, description, passed, reason = '' }) {
  if (passed === null || passed === undefined) {
    return { id, description, status: 'skip', actual: null, threshold: true, operator: '==', unit: '', reason: reason || 'measurement is unavailable' };
  }
  return { id, description, status: passed ? 'pass' : 'fail', actual: Boolean(passed), threshold: true, operator: '==', unit: '' };
}

export function skippedGate(id, description, reason) {
  return { id, description, status: 'skip', actual: null, threshold: null, operator: '', unit: '', reason };
}

export function finalizeReport(report) {
  const gates = Array.isArray(report.gates) ? report.gates : [];
  const totals = {
    pass: gates.filter((entry) => entry.status === 'pass').length,
    fail: gates.filter((entry) => entry.status === 'fail').length,
    skip: gates.filter((entry) => entry.status === 'skip').length,
  };
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    ...report,
    summary: {
      ...totals,
      qualification: totals.fail > 0 ? 'fail' : totals.skip > 0 ? 'partial' : 'pass',
      fullyQualified: totals.fail === 0 && totals.skip === 0,
    },
  };
}

export function parseHarnessArgs(argv, defaults = {}) {
  const options = {
    runs: 20,
    switches: 1_000,
    cycles: 100,
    maxTabs: 50,
    report: '',
    electronApp: '',
    browser: '',
    enforceComparison: process.env.BRAINROUTER_BROWSER_STABLE_RUNNER === '1',
    noChrome: false,
    ...defaults,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--runs') options.runs = boundedInteger(take(), 1, 200, arg);
    else if (arg === '--switches') options.switches = boundedInteger(take(), 2, 10_000, arg);
    else if (arg === '--cycles') options.cycles = boundedInteger(take(), 1, 1_000, arg);
    else if (arg === '--max-tabs') options.maxTabs = boundedInteger(take(), 20, 50, arg);
    else if (arg === '--report') options.report = path.resolve(take());
    else if (arg === '--electron-app') options.electronApp = path.resolve(take());
    else if (arg === '--browser') options.browser = path.resolve(take());
    else if (arg === '--enforce-comparison') options.enforceComparison = true;
    else if (arg === '--no-chrome') options.noChrome = true;
    else if (arg === '--quick') {
      options.runs = 3;
      options.switches = 20;
      options.cycles = 5;
      options.maxTabs = 20;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export function environmentMetadata(extra = {}) {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpuModel: cpus[0]?.model?.trim() || 'unknown',
    logicalCpus: cpus.length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
    stableRunner: process.env.BRAINROUTER_BROWSER_STABLE_RUNNER === '1',
    ...extra,
  };
}

export function writeJsonReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}

export function defaultReportPath(desktopRoot, filename) {
  return path.join(desktopRoot, '.browser-benchmarks', filename);
}

export function printGateSummary(report) {
  for (const item of report.gates ?? []) {
    if (item.status === 'pass') console.log(`PASS ${item.id}: ${formatGate(item)}`);
    else if (item.status === 'fail') console.error(`FAIL ${item.id}: ${formatGate(item)}`);
    else console.log(`SKIP ${item.id}: ${item.reason}`);
  }
  const summary = report.summary ?? { pass: 0, fail: 0, skip: 0, qualification: 'fail' };
  console.log(`Gates: ${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped (${summary.qualification})`);
}

function formatGate(item) {
  if (typeof item.actual === 'boolean') return `${item.actual} ${item.operator} ${item.threshold}`;
  return `${item.actual}${item.unit ? ` ${item.unit}` : ''} ${item.operator} ${item.threshold}${item.unit ? ` ${item.unit}` : ''}`;
}

function boundedInteger(raw, min, max, label) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
