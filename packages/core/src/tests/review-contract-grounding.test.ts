/**
 * ADR-027 D9.1 — the review contract must not contradict the evidence it ships with.
 *
 * The contracts asserted unconditionally that the reviewer had no tools and had
 * to base every finding on the diff alone. That was true when written, but the
 * scheduler since gained a real exact-revision checkout and a
 * `prepareRepositoryContext` hook. Handed repository context AND an instruction
 * to ignore everything outside the diff, a model follows the stronger, more
 * specific instruction — which is how a guard twenty lines below a hunk goes
 * unseen and a false positive gets filed.
 *
 * Both directions matter. Without context the no-tools framing must REMAIN:
 * told to "verify with read-only tools" it does not have, the model concludes
 * it could not verify and suppresses every finding.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSecurityReviewContract } from '../review/securityReview.js';
import { buildCodeReviewContract } from '../review/codeReviewContract.js';

const CONTRACTS = [
  { name: 'security', build: buildSecurityReviewContract },
  { name: 'code review', build: buildCodeReviewContract },
];

for (const { name, build } of CONTRACTS) {
  test(`${name}: without repository context, the no-tools framing is kept`, () => {
    const contract = build();
    assert.match(contract, /NO tools/, 'a model told to use tools it lacks suppresses every finding');
    assert.match(contract, /do not ask to open other files/);
    assert.doesNotMatch(contract, /repository context/i);
  });

  test(`${name}: the default (no argument) is the ungrounded contract`, () => {
    // The scheduler passes the flag explicitly; anything that forgets must get
    // the safe framing rather than a promise of context that is not there.
    assert.equal(build(), build({ repositoryContext: false }));
  });

  test(`${name}: with repository context, the contradiction is gone`, () => {
    const contract = build({ repositoryContext: true });
    assert.doesNotMatch(contract, /NO tools/,
      'claiming no tools while context sits above it is the contradiction this fixes');
    assert.doesNotMatch(contract, /Base every finding on evidence visible in the diff itself/);
    assert.match(contract, /repository context/i);
  });

  test(`${name}: the grounded contract still forbids requesting MORE files`, () => {
    // Context is bounded and already assembled. Inviting the model to ask for
    // more produces "I could not verify" and a suppressed review.
    const contract = build({ repositoryContext: true });
    assert.match(contract, /cannot request more files/i);
  });

  test(`${name}: the grounded contract keeps the untrusted-evidence framing`, () => {
    const contract = build({ repositoryContext: true });
    assert.match(contract, /untrusted evidence/i,
      'repository context is attacker-influenceable source text, not instructions');
  });

  test(`${name}: both forms still carry the JSON output contract`, () => {
    for (const contract of [build(), build({ repositoryContext: true })]) {
      assert.match(contract, /```json/, 'the shared parser depends on this tail');
      assert.match(contract, /"file"/);
      assert.match(contract, /"severity"/);
    }
  });
}

test('security: the grounded contract asks for negative controls', () => {
  // The single strongest defence against the false-positive class in D9.1: a
  // pattern repeated across unchanged call sites is the house convention.
  const contract = buildSecurityReviewContract({ repositoryContext: true });
  assert.match(contract, /NEGATIVE CONTROL/i);
  assert.match(contract, /unchanged/i);
});

test('security: the grounded contract still sweeps the vulnerability classes', () => {
  const contract = buildSecurityReviewContract({ repositoryContext: true });
  assert.match(contract, /SQL \/ NoSQL injection/);
  assert.match(contract, /Insecure direct object reference/);
});

test('code review: the grounded contract still refuses the security lens', () => {
  const contract = buildCodeReviewContract({ repositoryContext: true });
  assert.match(contract, /NOT security/);
});
