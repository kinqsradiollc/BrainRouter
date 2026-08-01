/**
 * ADR-027 D9 (P6-2/P6-3) — the additive PR gate.
 *
 * The property everything else serves: "we looked and were unsure" and "we
 * never looked" must not render identically. Every other review system forces
 * uncertainty into finding-or-nothing, and both are lies — one manufactures
 * confidence, the other manufactures coverage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLedger,
  fingerprintOf,
  describeLedger,
  METHOD_CEILING,
  DEFAULT_CONFIRM_BAR,
  type Candidate,
} from '../review/candidateLedger.js';

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  ruleId: 'CWE-89', file: 'src/db.ts', anchor: 'L42',
  method: 'source-and-sink', claimedConfidence: 90, title: 'SQL injection', ...over,
});

test('confidence is PINNED to method, whatever the model claimed', () => {
  // Self-reported confidence is a fluent guess. Pinning it to method is what
  // makes it comparable across runs and across models.
  const ledger = buildLedger({
    candidates: [cand({ method: 'heuristic', claimedConfidence: 99 })],
  });
  assert.equal(ledger.entries[0]!.confidence, METHOD_CEILING.heuristic);
  assert.equal(ledger.entries[0]!.disposition, 'deferred');
});

test('a weaker claim than the ceiling is not inflated to it', () => {
  const ledger = buildLedger({
    candidates: [cand({ method: 'source-and-sink', claimedConfidence: 40 })],
  });
  assert.equal(ledger.entries[0]!.confidence, 40);
});

test('uncertainty is DEFERRED, never silently dropped', () => {
  // The whole reason `deferred` is first-class.
  const ledger = buildLedger({ candidates: [cand({ method: 'pattern-match' })] });
  assert.equal(ledger.deferred.length, 1);
  assert.equal(ledger.confirmed.length, 0);
  assert.match(ledger.deferred[0]!.rationale, /recorded as uncertain rather than discarded/);
});

test('a confirmed entry records that counterevidence was considered', () => {
  const candidate = cand();
  const ledger = buildLedger({
    candidates: [candidate],
    counterevidence: [{
      fingerprint: fingerprintOf(candidate), refutes: false,
      reason: 'The parameter is bound, but the surrounding query is still concatenated.',
    }],
  });
  assert.equal(ledger.confirmed.length, 1);
  assert.match(ledger.confirmed[0]!.rationale, /Counterevidence considered and did not refute/);
});

test('counterevidence that refutes moves the entry, with the reason kept', () => {
  const candidate = cand();
  const ledger = buildLedger({
    candidates: [candidate],
    counterevidence: [{
      fingerprint: fingerprintOf(candidate), refutes: true,
      reason: 'The value is a compile-time constant.',
    }],
  });
  assert.equal(ledger.refuted.length, 1);
  assert.match(ledger.refuted[0]!.rationale, /compile-time constant/);
});

test('a suppression must name the EXACT row', () => {
  // A rule-wide suppression is not expressible: it would quietly cover future
  // instances nobody has looked at.
  const candidate = cand();
  const wrongRow = buildLedger({
    candidates: [candidate],
    suppressions: [{ fingerprint: 'not-this-row', reason: 'Accepted.' }],
  });
  assert.equal(wrongRow.suppressed.length, 0);
  assert.equal(wrongRow.confirmed.length, 1);

  const rightRow = buildLedger({
    candidates: [candidate],
    suppressions: [{ fingerprint: fingerprintOf(candidate), reason: 'Reviewed 2026-07; accepted.' }],
  });
  assert.equal(rightRow.suppressed.length, 1);
  assert.match(rightRow.suppressed[0]!.rationale, /Reviewed 2026-07/);
});

test('suppression is applied before counterevidence', () => {
  // A row someone explicitly closed should not generate work; re-deciding it
  // is effort spent on a settled question.
  const candidate = cand();
  const fingerprint = fingerprintOf(candidate);
  const ledger = buildLedger({
    candidates: [candidate],
    suppressions: [{ fingerprint, reason: 'Accepted.' }],
    counterevidence: [{ fingerprint, refutes: true, reason: 'Also refuted.' }],
  });
  assert.equal(ledger.suppressed.length, 1);
  assert.equal(ledger.refuted.length, 0);
});

test('a stale suppression matching nothing is reported', () => {
  // It will silently stop protecting anything, and nobody will notice.
  const ledger = buildLedger({
    candidates: [cand()],
    suppressions: [{ fingerprint: 'ghost', reason: 'Old.' }],
  });
  assert.deepEqual(ledger.orphanedSuppressions, ['ghost']);
  assert.match(describeLedger(ledger), /stale suppression/);
});

test('the fingerprint is stable across runs and across phrasing', () => {
  // A finding that changes identity cannot be suppressed, cannot be tracked to
  // closure, and reappears forever as new.
  const first = fingerprintOf(cand({ title: 'SQL injection', claimedConfidence: 90 }));
  const reworded = fingerprintOf(cand({ title: 'Unsanitised query input', claimedConfidence: 55 }));
  assert.equal(first, reworded, 'title and confidence drift; identity must not');
});

test('the fingerprint distinguishes rule, file, anchor, and instance', () => {
  const base = fingerprintOf(cand());
  assert.notEqual(base, fingerprintOf(cand({ ruleId: 'CWE-79' })));
  assert.notEqual(base, fingerprintOf(cand({ file: 'src/other.ts' })));
  assert.notEqual(base, fingerprintOf(cand({ anchor: 'L99' })));
  assert.notEqual(base, fingerprintOf(cand({ instance: 2 })));
});

test('every candidate appears in exactly one disposition bucket', () => {
  const candidates = [
    cand({ anchor: 'L1' }), cand({ anchor: 'L2', method: 'heuristic' }),
    cand({ anchor: 'L3' }), cand({ anchor: 'L4' }),
  ];
  const ledger = buildLedger({
    candidates,
    counterevidence: [{ fingerprint: fingerprintOf(candidates[2]!), refutes: true, reason: 'No.' }],
    suppressions: [{ fingerprint: fingerprintOf(candidates[3]!), reason: 'Accepted.' }],
  });
  const total = ledger.confirmed.length + ledger.deferred.length
    + ledger.refuted.length + ledger.suppressed.length;
  assert.equal(total, candidates.length);
  assert.equal(ledger.entries.length, candidates.length);
});

test('every entry carries a rationale — nothing is unexplained', () => {
  const ledger = buildLedger({ candidates: [cand(), cand({ method: 'heuristic', anchor: 'L2' })] });
  for (const entry of ledger.entries) assert.ok(entry.rationale.trim().length > 0);
});

test('the report distinguishes deferred from cleared', () => {
  // "We were unsure" and "we cleared it" carry completely different
  // obligations, so they must not collapse into one number.
  const text = describeLedger(buildLedger({
    candidates: [cand(), cand({ anchor: 'L2', method: 'pattern-match' })],
  }));
  assert.match(text, /1 confirmed/);
  assert.match(text, /1 deferred \(uncertain, not cleared\)/);
});

test('the confirm bar is configurable and defaults sensibly', () => {
  const candidates = [cand({ method: 'sink-only', claimedConfidence: 70 })];
  assert.equal(buildLedger({ candidates }).confirmed.length, 1, `default bar is ${DEFAULT_CONFIRM_BAR}`);
  assert.equal(buildLedger({ candidates, confirmBar: 90 }).deferred.length, 1);
});

test('no candidates says so plainly', () => {
  assert.equal(describeLedger(buildLedger({ candidates: [] })), 'No candidates were raised.');
});
