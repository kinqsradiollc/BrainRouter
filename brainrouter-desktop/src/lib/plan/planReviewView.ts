/**
 * §7 PLAN REVIEW — pure presentation helpers for the Plan panel's approval +
 * version-history surface. The CLI owns the durable store (recordPlanDecision /
 * readPlanHistory / diffSnapshots in planHistoryStore, all tested there); this
 * shapes a PlanDecision[] into display rows (newest-first, with the diff from
 * the previous snapshot) and derives the current plan's approval state, so the
 * sorting / diffing / "approved then changed" logic is unit-testable without
 * the host. A self-contained snapshot diff (mirrors the CLI's diffSnapshots)
 * keeps the renderer free of any CLI import.
 */
import type { PlanItem } from '../../types.js';

export type PlanVerdict = 'approved' | 'changes-requested' | 'revised';

/** A durable plan decision as the host returns it (mirrors PlanDecision). */
export interface PlanDecisionView {
  id: string;
  verdict: PlanVerdict;
  /** `auto` = recorded automatically under auto mode (no approval prompt). */
  actor?: 'user' | 'auto';
  feedback?: string;
  planSnapshot: PlanItem[];
  explanation?: string;
  requirementId?: string;
  linkedMemoryIds?: string[];
  createdAt: string;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: Array<{ step: string; from: string; to: string }>;
}

/**
 * Pure diff between two plan snapshots, keyed by step text — which steps were
 * added / removed, and which kept the step but changed status. Mirrors the
 * CLI's diffSnapshots so the panel can show "vs previous" without a round-trip.
 */
export function diffPlanSnapshots(before: PlanItem[], after: PlanItem[]): SnapshotDiff {
  const beforeByStep = new Map(before.map((i) => [i.step, i.status as string]));
  const afterByStep = new Map(after.map((i) => [i.step, i.status as string]));
  const added = after.filter((i) => !beforeByStep.has(i.step)).map((i) => i.step);
  const removed = before.filter((i) => !afterByStep.has(i.step)).map((i) => i.step);
  const changed: SnapshotDiff['changed'] = [];
  for (const [step, from] of beforeByStep) {
    const to = afterByStep.get(step);
    if (to !== undefined && to !== from) changed.push({ step, from, to });
  }
  return { added, removed, changed };
}

/** True when a diff carries no change (used to hide an empty "vs previous" line). */
export function isEmptyDiff(d: SnapshotDiff): boolean {
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
}

export interface PlanDecisionRow extends PlanDecisionView {
  /** Change from the chronologically-previous decision's snapshot (undefined for the first). */
  diffFromPrev?: SnapshotDiff;
}

/**
 * Newest-first decision rows, each annotated with the diff from the
 * chronologically-previous snapshot (append order is oldest-first, so the diff
 * is computed against the row that precedes it in time). Pure + non-mutating.
 */
export function planHistoryRows(decisions: PlanDecisionView[]): PlanDecisionRow[] {
  const rows: PlanDecisionRow[] = decisions.map((d, i) => {
    const row: PlanDecisionRow = { ...d };
    if (i > 0) row.diffFromPrev = diffPlanSnapshots(decisions[i - 1].planSnapshot, d.planSnapshot);
    return row;
  });
  return rows.reverse();
}

/** The most recent decision (chronologically last), or null when there is none. */
export function latestDecision(decisions: PlanDecisionView[]): PlanDecisionView | null {
  return decisions.length ? decisions[decisions.length - 1] : null;
}

export type PlanApprovalState =
  | { kind: 'none' }                                   // no plan / never reviewed
  | { kind: 'approved'; decisionId: string }           // current plan == last-approved snapshot
  | { kind: 'changes-requested'; feedback?: string }   // last decision asked for changes
  | { kind: 'revised'; decisionId: string }            // a revision task rewrote the plan — re-review
  | { kind: 'changed-since-approval'; decisionId: string }; // approved, but the plan moved on

/**
 * Derive the current plan's approval state from the decision history:
 * - no plan or no decisions → none
 * - last decision was changes-requested → changes-requested (+ feedback)
 * - last decision was revised → revised (a revision task rewrote the plan; re-review)
 * - last decision was approved AND the live plan still matches its snapshot → approved
 * - last decision was approved but the live plan has since changed → changed-since-approval
 * "matches" is a structural step+status comparison (an empty diff both ways).
 */
export function planApprovalState(
  plan: { items: PlanItem[] } | null,
  decisions: PlanDecisionView[],
): PlanApprovalState {
  if (!plan || plan.items.length === 0) return { kind: 'none' };
  const last = latestDecision(decisions);
  if (!last) return { kind: 'none' };
  if (last.verdict === 'changes-requested') return { kind: 'changes-requested', feedback: last.feedback };
  if (last.verdict === 'revised') return { kind: 'revised', decisionId: last.id };
  // approved
  const matches = isEmptyDiff(diffPlanSnapshots(last.planSnapshot, plan.items));
  return matches
    ? { kind: 'approved', decisionId: last.id }
    : { kind: 'changed-since-approval', decisionId: last.id };
}

/** Short label for an approval-state banner. */
export function approvalLabel(state: PlanApprovalState): string {
  switch (state.kind) {
    case 'approved': return 'Plan approved';
    case 'changes-requested': return 'Changes requested';
    case 'revised': return 'Plan revised — review again';
    case 'changed-since-approval': return 'Changed since approval';
    case 'none': return 'Not reviewed';
  }
}
