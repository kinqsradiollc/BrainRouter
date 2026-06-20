import test from 'node:test';
import assert from 'node:assert/strict';
import { hashDiff, reviewGate, unresolvedBlocking, setFindingStatus, staleIfDiffChanged, isFindingStatus, FINDING_STATUSES, TRIAGE_STATUSES, type ReviewRun, type ReviewFinding } from '../review/reviewModel.js';

const finding = (over: Partial<ReviewFinding>): ReviewFinding => ({
  id: 'f1', file: 'a.ts', severity: 'high', confidence: 90, summary: 's', status: 'open', canApply: false, source: 'ai-review', ...over,
});
const run = (over: Partial<ReviewRun>): ReviewRun => ({
  id: 'r1', workspaceRoot: '/w', repoRoot: '/w', baseRef: 'HEAD', headRef: 'WT', diffHash: 'h1',
  createdAt: 't', updatedAt: 't', status: 'completed', summary: '', findings: [], ...over,
});

test('hashDiff is stable + whitespace-tail/CRLF insensitive', () => {
  assert.equal(hashDiff('a\nb'), hashDiff('a\nb'));
  assert.equal(hashDiff('a\r\nb\n'), hashDiff('a\nb'));
  assert.notEqual(hashDiff('a\nb'), hashDiff('a\nc'));
});

test('gate: no review → needs-review + blocked', () => {
  const g = reviewGate(null, 'h1');
  assert.equal(g.status, 'needs-review'); assert.equal(g.blocked, true);
});

test('gate: review for a DIFFERENT diff hash → stale + blocked', () => {
  const g = reviewGate(run({ diffHash: 'old' }), 'new');
  assert.equal(g.status, 'stale'); assert.equal(g.blocked, true);
});

test('gate: running review → blocked', () => {
  assert.equal(reviewGate(run({ status: 'running' }), 'h1').status, 'running');
});

test('gate: completed with an unresolved HIGH finding → blocked', () => {
  const g = reviewGate(run({ findings: [finding({ severity: 'high', status: 'open' })] }), 'h1');
  assert.equal(g.status, 'blocked'); assert.equal(g.blocked, true);
  assert.equal(g.blockingFindings.length, 1);
});

test('gate: a dismissed/fixed/applied HIGH finding no longer blocks', () => {
  for (const st of ['dismissed', 'fixed', 'applied'] as const) {
    const g = reviewGate(run({ findings: [finding({ severity: 'high', status: st })] }), 'h1');
    assert.equal(g.blocked, false, `${st} should not block`);
  }
});

test('gate: triage statuses (acknowledged/disputed/out-of-scope) clear a HIGH finding', () => {
  for (const st of TRIAGE_STATUSES) {
    const g = reviewGate(run({ findings: [finding({ severity: 'critical', status: st })] }), 'h1');
    assert.equal(g.blocked, false, `${st} should not block`);
  }
  // sanity: an OPEN critical still blocks
  assert.equal(reviewGate(run({ findings: [finding({ severity: 'critical', status: 'open' })] }), 'h1').blocked, true);
});

test('isFindingStatus narrows known statuses and rejects junk', () => {
  for (const st of FINDING_STATUSES) assert.equal(isFindingStatus(st), true, st);
  for (const bad of ['', 'nope', 'OPEN', 42, null, undefined, {}]) assert.equal(isFindingStatus(bad), false);
});

test('gate: only low/medium findings → clean (not blocked) at default high threshold', () => {
  const g = reviewGate(run({ findings: [finding({ severity: 'medium', status: 'open' }), finding({ id: 'f2', severity: 'low', status: 'open' })] }), 'h1');
  assert.equal(g.status, 'clean'); assert.equal(g.blocked, false);
});

test('gate: clean review (no findings) passes', () => {
  assert.equal(reviewGate(run({ findings: [] }), 'h1').status, 'clean');
});

test('unresolvedBlocking respects the severity floor', () => {
  const r = run({ findings: [finding({ severity: 'critical', status: 'open' }), finding({ id: 'f2', severity: 'medium', status: 'open' })] });
  assert.equal(unresolvedBlocking(r, 'high').length, 1, 'only critical clears the high floor');
  assert.equal(unresolvedBlocking(r, 'low').length, 2);
});

test('setFindingStatus updates one finding immutably', () => {
  const r = run({ findings: [finding({ id: 'x' })] });
  const next = setFindingStatus(r, 'x', 'dismissed', 'later');
  assert.equal(next.findings[0].status, 'dismissed');
  assert.equal(r.findings[0].status, 'open', 'original untouched');
  assert.equal(next.updatedAt, 'later');
});

test('staleIfDiffChanged flips a completed run to stale when the hash differs', () => {
  assert.equal(staleIfDiffChanged(run({ diffHash: 'h1' }), 'h2').status, 'stale');
  assert.equal(staleIfDiffChanged(run({ diffHash: 'h1' }), 'h1').status, 'completed', 'same hash stays');
  assert.equal(staleIfDiffChanged(run({ status: 'running', diffHash: 'h1' }), 'h2').status, 'running', 'running not marked stale');
});
