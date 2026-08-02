/**
 * ADR-027 D1 (P9-1) — verification receipts and the technical-debt ledger.
 *
 * The distinction these defend: "we ran nothing over this file" and "we ran
 * something and it passed" are OPPOSITE states. A receipt that reports only
 * failures makes them look identical — which is how untested code comes to read
 * as tested code, and how a green build convinces a team it has coverage it
 * never had.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDebtBalance,
  describeDebtBalance,
  receiptProblems,
  type VerificationReceipt,
} from '../debt/verificationReceipt.js';

const receipt = (over: Partial<VerificationReceipt> = {}): VerificationReceipt => ({
  changed: ['src/a.ts', 'src/b.ts'],
  checks: [{ name: 'unit', outcome: 'passed', covered: ['src/a.ts', 'src/b.ts'] }],
  ...over,
});

test('a fully covered change carries no debt', () => {
  const balance = computeDebtBalance(receipt());
  assert.deepEqual(balance.verifiedFiles, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(balance.unverifiedFiles, []);
  assert.equal(balance.verifiedFraction, 1);
});

test('a file no check touched is UNVERIFIED, not silently fine', () => {
  // The whole point: absence of a failure is not evidence of a pass.
  const balance = computeDebtBalance(receipt({
    changed: ['src/a.ts', 'src/untested.ts'],
    checks: [{ name: 'unit', outcome: 'passed', covered: ['src/a.ts'] }],
  }));
  assert.deepEqual(balance.unverifiedFiles, ['src/untested.ts']);
  assert.equal(balance.verifiedFraction, 0.5);
});

test('a file covered only by a FAILING check counts as failing, never verified', () => {
  // Running a check and ignoring its result is worse than never running it: it
  // produces a record that looks like diligence.
  const balance = computeDebtBalance(receipt({
    changed: ['src/a.ts'],
    checks: [{ name: 'unit', outcome: 'failed', covered: ['src/a.ts'] }],
  }));
  assert.deepEqual(balance.failingFiles, ['src/a.ts']);
  assert.deepEqual(balance.verifiedFiles, []);
  assert.equal(balance.verifiedFraction, 0);
});

test('a failing check outranks a passing one on the same file', () => {
  // One suite passing does not absolve another suite failing over the same code.
  const balance = computeDebtBalance(receipt({
    changed: ['src/a.ts'],
    checks: [
      { name: 'unit', outcome: 'passed', covered: ['src/a.ts'] },
      { name: 'integration', outcome: 'failed', covered: ['src/a.ts'] },
    ],
  }));
  assert.deepEqual(balance.failingFiles, ['src/a.ts']);
  assert.deepEqual(balance.verifiedFiles, []);
});

test('a skipped check verifies nothing and is reported with its reason', () => {
  const balance = computeDebtBalance(receipt({
    changed: ['src/a.ts'],
    checks: [{ name: 'e2e', outcome: 'skipped', covered: [], reason: 'No display available.' }],
  }));
  assert.deepEqual(balance.unverifiedFiles, ['src/a.ts']);
  assert.deepEqual(balance.skipped, [{ name: 'e2e', reason: 'No display available.' }]);
});

test('the three buckets partition the changed set exactly', () => {
  const balance = computeDebtBalance(receipt({
    changed: ['ok.ts', 'bad.ts', 'none.ts'],
    checks: [
      { name: 'unit', outcome: 'passed', covered: ['ok.ts'] },
      { name: 'unit2', outcome: 'failed', covered: ['bad.ts'] },
    ],
  }));
  assert.deepEqual(
    [...balance.verifiedFiles, ...balance.failingFiles, ...balance.unverifiedFiles].sort(),
    ['bad.ts', 'none.ts', 'ok.ts'],
  );
});

test('the balance is descriptive, never a scolding', () => {
  // D1 rejects the alert list outright. A number the user is scolded with gets
  // dismissed, and a dismissed number measures nothing.
  const text = describeDebtBalance(computeDebtBalance(receipt({
    changed: ['a.ts', 'b.ts', 'c.ts'],
    checks: [{ name: 'unit', outcome: 'passed', covered: ['a.ts'] }],
  })));
  assert.match(text, /1\/3 changed file\(s\) verified/);
  assert.doesNotMatch(text, /should|must|warning|⚠|error/i);
});

test('unverified files are NAMED, not just counted', () => {
  // A bare count is a number you cannot act on, and the point of a balance is
  // that acting on it stays possible.
  const text = describeDebtBalance(computeDebtBalance(receipt({
    changed: ['a.ts', 'skipped-me.ts'],
    checks: [{ name: 'unit', outcome: 'passed', covered: ['a.ts'] }],
  })));
  assert.match(text, /skipped-me\.ts/);
});

test('a long list is truncated with a count rather than dumped', () => {
  const changed = Array.from({ length: 9 }, (_, i) => `f${i}.ts`);
  const text = describeDebtBalance(computeDebtBalance({ changed, checks: [] }));
  assert.match(text, /and 5 more/);
});

test('an unexplained skip is a receipt problem', () => {
  // Indistinguishable from an oversight, and it reads as deliberate.
  const problems = receiptProblems(receipt({
    checks: [{ name: 'e2e', outcome: 'skipped', covered: [] }],
  }));
  assert.ok(problems.some((p) => /skipped with no reason/.test(p)));
});

test('a skipped check claiming coverage is a receipt problem', () => {
  const problems = receiptProblems(receipt({
    checks: [{ name: 'e2e', outcome: 'skipped', covered: ['src/a.ts'], reason: 'CI only.' }],
  }));
  assert.ok(problems.some((p) => /skipped but claims to cover/.test(p)));
});

test('claiming coverage of an unchanged file is a receipt problem', () => {
  // Not wrong in itself, but claiming it in THIS receipt inflates the apparent
  // diligence for this change.
  const problems = receiptProblems(receipt({
    changed: ['src/a.ts'],
    checks: [{ name: 'unit', outcome: 'passed', covered: ['src/a.ts', 'src/elsewhere.ts'] }],
  }));
  assert.ok(problems.some((p) => /did not touch/.test(p)));
});

test('a sound receipt reports no problems', () => {
  assert.deepEqual(receiptProblems(receipt()), []);
});

test('a change touching nothing is trivially complete', () => {
  const balance = computeDebtBalance({ changed: [], checks: [] });
  assert.equal(balance.verifiedFraction, 1);
  assert.equal(describeDebtBalance(balance), 'No files changed.');
});
