/**
 * ADR-027 D9.1 (P6-6) — expanding a review from changed code to its neighbours.
 *
 * A diff shows what changed, not what already guards it. Reviewing a changed
 * shared helper without its call sites answers the wrong question twice over:
 *
 *   - IMPACT is invisible. Whether a signature change breaks a caller cannot be
 *     read off the hunk that changed the callee.
 *   - NEGATIVE CONTROLS are unavailable, and this is the one that matters most.
 *     A pattern appearing in twelve unchanged call sites and one changed one is
 *     almost always the house convention, not a newly introduced defect.
 *     Without the twelve, the one looks like a finding. That is precisely the
 *     false-positive class that produced the CWE-863 report on #1271.
 *
 * Expansion is not free — every neighbour costs review tokens — so this is a
 * BUDGETED selection, not "read everything". The budget is spent in a fixed
 * priority order and what it could not afford is reported rather than dropped
 * silently, because an unreported truncation reads as "we looked at everything".
 */

/** Why a neighbour was pulled in. Recorded so a reader can tell impact from control. */
export type ExpansionRole =
  /** Calls into changed code — needed to judge impact. */
  | 'caller'
  /** Called by changed code — needed to judge whether a guard already exists. */
  | 'callee'
  /**
   * Unchanged code exhibiting the same pattern as the change. The comparison
   * that stops house conventions being reported as defects.
   */
  | 'negative-control';

export interface ExpansionCandidate {
  path: string;
  role: ExpansionRole;
  /** Cost of including this file, in whatever unit the caller budgets (usually bytes). */
  weight: number;
}

export interface ExpansionSelection {
  /** Files to include, in the order they were selected. */
  included: readonly ExpansionCandidate[];
  /** Candidates the budget could not afford. Never silently discarded. */
  dropped: readonly ExpansionCandidate[];
  /** Total weight of `included`. */
  usedWeight: number;
  /** True when every candidate fit. */
  complete: boolean;
}

/**
 * Priority order when the budget cannot hold everything.
 *
 * Callees first: they answer "does a guard already exist", which is what turns a
 * confident false positive into a non-finding. Negative controls rank ABOVE
 * callers deliberately — knowing a pattern is conventional prevents a wrong
 * report, whereas a missed caller costs a missed impact note. Both matter, but
 * a false positive burns the reviewer's credibility and a reader's time in a
 * way an omission does not.
 */
const ROLE_PRIORITY: Record<ExpansionRole, number> = {
  callee: 0,
  'negative-control': 1,
  caller: 2,
};

export interface ExpansionInput {
  /** Files already in the review because they changed. Never re-included. */
  changed: readonly string[];
  candidates: readonly ExpansionCandidate[];
  /** Total weight expansion may spend. */
  budget: number;
  /** Hard cap on how many neighbours to include regardless of budget. */
  maxFiles?: number;
}

/**
 * Choose which neighbours to pull into the review.
 *
 * Deterministic: candidates are ordered by role priority, then by ascending
 * weight, then by path. Two runs over the same revision must select the same
 * files, or coverage stops being comparable between runs and a finding's
 * appearance or disappearance cannot be attributed.
 */
export function selectExpansion(input: ExpansionInput): ExpansionSelection {
  const changed = new Set(input.changed);
  const maxFiles = input.maxFiles ?? Number.POSITIVE_INFINITY;

  // Dedupe by path, keeping the highest-priority role for a file that qualifies
  // as more than one thing (a caller that also demonstrates the pattern).
  const byPath = new Map<string, ExpansionCandidate>();
  for (const candidate of input.candidates) {
    if (changed.has(candidate.path)) continue; // already in the review
    const existing = byPath.get(candidate.path);
    if (!existing || ROLE_PRIORITY[candidate.role] < ROLE_PRIORITY[existing.role]) {
      byPath.set(candidate.path, candidate);
    }
  }

  const ordered = [...byPath.values()].sort((a, b) =>
    ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role]
    || a.weight - b.weight
    || a.path.localeCompare(b.path));

  const included: ExpansionCandidate[] = [];
  const dropped: ExpansionCandidate[] = [];
  let usedWeight = 0;

  for (const candidate of ordered) {
    // Cheaper candidates later in the order still get a chance — a single huge
    // callee must not consume the budget and starve everything behind it.
    if (included.length >= maxFiles || usedWeight + candidate.weight > input.budget) {
      dropped.push(candidate);
      continue;
    }
    included.push(candidate);
    usedWeight += candidate.weight;
  }

  return { included, dropped, usedWeight, complete: dropped.length === 0 };
}

/**
 * Render the expansion decision.
 *
 * A truncated expansion MUST say so. Reporting only what was included lets a
 * budget-limited run read exactly like an exhaustive one.
 */
export function describeExpansion(selection: ExpansionSelection): string {
  if (selection.included.length === 0 && selection.dropped.length === 0) {
    return 'No neighbouring files were available to expand into.';
  }
  const counts = new Map<ExpansionRole, number>();
  for (const file of selection.included) counts.set(file.role, (counts.get(file.role) ?? 0) + 1);
  const breakdown = (['callee', 'negative-control', 'caller'] as const)
    .filter((role) => counts.has(role))
    .map((role) => `${counts.get(role)} ${role}`)
    .join(', ');

  const head = selection.included.length > 0
    ? `Expanded into ${selection.included.length} neighbouring file(s) (${breakdown})`
    : 'No neighbouring files fit the expansion budget';

  return selection.complete
    ? head
    : `${head} · **${selection.dropped.length} omitted for budget** — impact and convention checks are incomplete for those`;
}
