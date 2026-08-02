/**
 * ADR-027 D9 (P6-1) — the local pre-commit gate.
 *
 * A subtractive engine's danger is that it hides things. So the tests care
 * about two properties above all: every drop is RECORDED with its reason, and
 * the count of drops is never suppressed — because an engine that silently
 * discards is indistinguishable from one that found nothing, and that
 * difference decides whether the tool is trustworthy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySubtractiveGate,
  shouldBlockCommit,
  describeGateResult,
  DEFAULT_CONFIDENCE_BAR,
  type LocalFinding,
  type LanguageClass,
} from '../review/subtractiveGate.js';

const finding = (over: Partial<LocalFinding> = {}): LocalFinding => ({
  id: 'f1', file: 'src/app.ts', title: 'Something', confidence: 95, severity: 'high', ...over,
});

const asLanguage = (map: Record<string, LanguageClass>) =>
  (file: string): LanguageClass => map[file] ?? 'unknown';

const ts = asLanguage({ 'src/app.ts': 'memory-safe' });

test('a high-confidence finding survives all three subtractions', () => {
  const result = applySubtractiveGate({ findings: [finding()], languageOf: ts });
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped.length, 0);
});

test('a memory-safety finding in a GC language is a CATEGORY ERROR, not a weak one', () => {
  // Reported as a language drop rather than low confidence, because the two say
  // different things about whether the reviewer is working.
  const result = applySubtractiveGate({
    findings: [finding({ ruleId: 'CWE-416', title: 'Use after free' })],
    languageOf: ts,
  });
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped[0]!.by, 'language');
  assert.match(result.dropped[0]!.reason, /cannot apply in memory-safe code/);
});

test('path traversal and SQL injection are impossible in front-end code', () => {
  const languageOf = asLanguage({ 'web/App.tsx': 'frontend' });
  for (const ruleId of ['CWE-22', 'CWE-89', 'CWE-78']) {
    const result = applySubtractiveGate({
      findings: [finding({ ruleId, file: 'web/App.tsx' })], languageOf,
    });
    assert.equal(result.dropped[0]!.by, 'language', `${ruleId} should be a category error`);
  }
});

test('the same rule survives in a language where it CAN apply', () => {
  // The exclusion must be conditional, not a blanket suppression.
  const result = applySubtractiveGate({
    findings: [finding({ ruleId: 'CWE-416', file: 'src/mem.c' })],
    languageOf: asLanguage({ 'src/mem.c': 'memory-unsafe' }),
  });
  assert.equal(result.kept.length, 1);
});

test('a precedent suppresses a settled pattern and says why', () => {
  // Re-litigating a decision the team already made is how a gate trains people
  // to dismiss it without reading.
  const result = applySubtractiveGate({
    findings: [finding({ ruleId: 'CWE-798' })],
    languageOf: ts,
    precedents: [{ ruleId: 'CWE-798', reason: 'Test fixtures use a known dummy credential.' }],
  });
  assert.equal(result.dropped[0]!.by, 'precedent');
  assert.match(result.dropped[0]!.reason, /dummy credential/);
});

test('a path-scoped precedent applies only inside its scope', () => {
  const precedents = [{ ruleId: 'CWE-798', pathPrefix: 'tests/', reason: 'Fixtures only.' }];
  const inScope = applySubtractiveGate({
    findings: [finding({ ruleId: 'CWE-798', file: 'tests/fixture.ts' })],
    languageOf: asLanguage({ 'tests/fixture.ts': 'memory-safe' }), precedents,
  });
  assert.equal(inScope.kept.length, 0);

  const outOfScope = applySubtractiveGate({
    findings: [finding({ ruleId: 'CWE-798', file: 'src/auth.ts' })],
    languageOf: asLanguage({ 'src/auth.ts': 'memory-safe' }), precedents,
  });
  assert.equal(outOfScope.kept.length, 1, 'production code is not covered by a test precedent');
});

test('a finding below the confidence bar is dropped and the bar is stated', () => {
  const result = applySubtractiveGate({ findings: [finding({ confidence: 60 })], languageOf: ts });
  assert.equal(result.dropped[0]!.by, 'confidence');
  assert.match(result.dropped[0]!.reason, new RegExp(String(DEFAULT_CONFIDENCE_BAR)));
});

test('the bar is configurable per workspace', () => {
  const findings = [finding({ confidence: 60 })];
  assert.equal(applySubtractiveGate({ findings, languageOf: ts, confidenceBar: 50 }).kept.length, 1);
  assert.equal(applySubtractiveGate({ findings, languageOf: ts, confidenceBar: 90 }).kept.length, 0);
});

test('subtraction order attributes a category error correctly even at low confidence', () => {
  // If confidence ran first this would report "low confidence" and hide a rule
  // firing where it cannot possibly apply.
  const result = applySubtractiveGate({
    findings: [finding({ ruleId: 'CWE-416', confidence: 10 })], languageOf: ts,
  });
  assert.equal(result.dropped[0]!.by, 'language');
});

test('every finding is accounted for — kept or dropped, never vanished', () => {
  const findings = [
    finding({ id: 'a', confidence: 95 }),
    finding({ id: 'b', confidence: 10 }),
    finding({ id: 'c', ruleId: 'CWE-416' }),
    finding({ id: 'd', ruleId: 'CWE-798' }),
  ];
  const result = applySubtractiveGate({
    findings, languageOf: ts,
    precedents: [{ ruleId: 'CWE-798', reason: 'Accepted.' }],
  });
  const seen = [...result.kept.map((f) => f.id), ...result.dropped.map((r) => r.finding.id)].sort();
  assert.deepEqual(seen, ['a', 'b', 'c', 'd']);
});

test('the drop count is always reported, never hidden', () => {
  // An engine that silently discards is indistinguishable from one that found
  // nothing.
  const result = applySubtractiveGate({
    findings: [finding({ confidence: 10 }), finding({ id: 'x', ruleId: 'CWE-416' })],
    languageOf: ts,
  });
  const text = describeGateResult(result);
  assert.match(text, /2 suppressed/);
  assert.match(text, /confidence/);
  assert.match(text, /language/);
});

test('the gate is ADVISORY by default — the owner decision in §5', () => {
  // A gate that blocks at the moment of commit is the one people route around
  // or switch off, and a switched-off gate reviews nothing.
  const result = applySubtractiveGate({
    findings: [finding({ severity: 'critical' })], languageOf: ts,
  });
  assert.equal(result.blocking, false);
  assert.equal(shouldBlockCommit(result), false);
});

test('opting in blocks only on a surviving critical or high', () => {
  const critical = applySubtractiveGate({
    findings: [finding({ severity: 'critical' })], languageOf: ts, blocking: true,
  });
  assert.equal(shouldBlockCommit(critical), true);

  const low = applySubtractiveGate({
    findings: [finding({ severity: 'low' })], languageOf: ts, blocking: true,
  });
  assert.equal(shouldBlockCommit(low), false);

  // A critical that was SUBTRACTED must not block — that is the whole point.
  const suppressed = applySubtractiveGate({
    findings: [finding({ severity: 'critical', ruleId: 'CWE-416' })], languageOf: ts, blocking: true,
  });
  assert.equal(shouldBlockCommit(suppressed), false);
});

test('no findings at all says so plainly', () => {
  const result = applySubtractiveGate({ findings: [], languageOf: ts });
  assert.equal(describeGateResult(result), 'No findings.');
});
