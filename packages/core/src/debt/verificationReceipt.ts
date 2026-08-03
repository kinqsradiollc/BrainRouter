/**
 * ADR-027 D1 (P9-1) — verification receipts and the technical-debt ledger.
 *
 * D1: "Every change carries a verification receipt — what was run, what passed,
 * what was NOT covered. Unverified surface is tracked as a debt balance rather
 * than surfaced as an alert list."
 *
 * The third clause is the one that carries the design. It would be easy to emit
 * a warning per unverified file, and it would be useless: §1's evidence has
 * notification acceptance decaying roughly 30% per additional item, so an alert
 * list is a mechanism for producing dismissal at scale. A balance is a number
 * you can watch move. One is checked when you choose to; the other trains you
 * to ignore it and then, having been ignored, measures nothing.
 *
 * The distinction this module refuses to blur: "we ran nothing over this file"
 * and "we ran something and it passed" are opposite states. A receipt that
 * reports only failures makes them look identical — which is how untested code
 * comes to read as tested code, and how a green build convinces a team it has
 * coverage it never had.
 */

export type CheckOutcome = 'passed' | 'failed' | 'skipped';

export interface VerificationCheck {
  /** What ran: a test file, a linter, a typecheck, a manual step. */
  name: string;
  outcome: CheckOutcome;
  /** Files this check actually exercised. */
  covered: readonly string[];
  /** Why it was skipped. Required for `skipped` — an unexplained skip is noise. */
  reason?: string;
}

export interface VerificationReceipt {
  /** Files the change touched. The denominator. */
  changed: readonly string[];
  checks: readonly VerificationCheck[];
}

export interface DebtBalance {
  changedFiles: number;
  /** Changed files exercised by at least one PASSING check. */
  verifiedFiles: readonly string[];
  /** Changed files no passing check touched. The debt. */
  unverifiedFiles: readonly string[];
  /** Files a check covered but that check FAILED — worse than unverified. */
  failingFiles: readonly string[];
  /** Checks skipped, with their stated reasons. */
  skipped: readonly { name: string; reason: string }[];
  /** 0–1. Reported, never used to gate. */
  verifiedFraction: number;
}

/**
 * Compute the balance.
 *
 * A file covered ONLY by a failing check counts as failing, not as verified —
 * running a check and ignoring its result is worse than never running it,
 * because it produces a record that looks like diligence.
 */
export function computeDebtBalance(receipt: VerificationReceipt): DebtBalance {
  const changed = [...new Set(receipt.changed)].sort();
  const passing = new Set<string>();
  const failing = new Set<string>();

  for (const check of receipt.checks) {
    if (check.outcome === 'passed') for (const file of check.covered) passing.add(file);
    else if (check.outcome === 'failed') for (const file of check.covered) failing.add(file);
  }

  const verifiedFiles = changed.filter((file) => passing.has(file) && !failing.has(file));
  const failingFiles = changed.filter((file) => failing.has(file));
  const unverifiedFiles = changed.filter((file) => !passing.has(file) && !failing.has(file));

  return {
    changedFiles: changed.length,
    verifiedFiles,
    unverifiedFiles,
    failingFiles,
    skipped: receipt.checks
      .filter((check) => check.outcome === 'skipped')
      .map((check) => ({ name: check.name, reason: check.reason ?? 'No reason given.' })),
    verifiedFraction: changed.length === 0 ? 1 : verifiedFiles.length / changed.length,
  };
}

/**
 * Render the balance.
 *
 * Descriptive, not imperative. No "you should", no warning glyphs, no per-file
 * alerts. D1 rejects the alert list explicitly, and the reason is mechanical
 * rather than stylistic: a number the user is scolded with gets dismissed, and
 * a dismissed number measures nothing.
 *
 * Unverified files are NAMED though — a bare count is a number you cannot act
 * on, and the point of a balance is that acting on it stays possible.
 */
export function describeDebtBalance(balance: DebtBalance): string {
  if (balance.changedFiles === 0) return 'No files changed.';

  const parts = [`${balance.verifiedFiles.length}/${balance.changedFiles} changed file(s) verified`];

  if (balance.failingFiles.length > 0) {
    parts.push(`${balance.failingFiles.length} with a failing check: ${listOf(balance.failingFiles)}`);
  }
  if (balance.unverifiedFiles.length > 0) {
    parts.push(`${balance.unverifiedFiles.length} not covered by any check: ${listOf(balance.unverifiedFiles)}`);
  }
  if (balance.skipped.length > 0) {
    parts.push(`${balance.skipped.length} check(s) skipped (${balance.skipped.map((s) => s.name).join(', ')})`);
  }
  return parts.join(' · ');
}

function listOf(files: readonly string[], limit = 4): string {
  const shown = files.slice(0, limit).join(', ');
  return files.length > limit ? `${shown} and ${files.length - limit} more` : shown;
}

/**
 * Whether a receipt is internally coherent.
 *
 * Returns the problems, empty when sound. A receipt is evidence, and evidence
 * that contradicts itself is worse than none: it will be cited later by someone
 * who did not check it.
 */
export function receiptProblems(receipt: VerificationReceipt): readonly string[] {
  const problems: string[] = [];
  const changed = new Set(receipt.changed);

  for (const check of receipt.checks) {
    if (check.outcome === 'skipped' && !check.reason?.trim()) {
      // An unexplained skip is indistinguishable from an oversight, and reads
      // as deliberate.
      problems.push(`Check "${check.name}" is skipped with no reason given`);
    }
    if (check.outcome === 'skipped' && check.covered.length > 0) {
      problems.push(`Check "${check.name}" is skipped but claims to cover ${check.covered.length} file(s)`);
    }
    for (const file of check.covered) {
      if (!changed.has(file)) {
        // Coverage of an unchanged file is not wrong, but claiming it in THIS
        // receipt inflates the appearance of diligence for this change.
        problems.push(`Check "${check.name}" claims coverage of "${file}", which this change did not touch`);
      }
    }
  }
  return problems;
}
