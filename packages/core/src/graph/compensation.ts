/**
 * ADR-027 D2 (P3-2) — compensation ordering and the non-compensable pivot.
 *
 * D2 states the rule plainly: "not everything is compensable, so the graph must
 * order non-compensable steps as late as possible and require confirmation
 * before crossing that pivot."
 *
 * The reason is asymmetric cost. A plan that sends an email, then fails writing
 * a local file, cannot be undone — the email is gone. The same plan with the
 * file write first fails harmlessly and retries. Nothing about the work
 * changed; only the order did. So ordering is not an optimisation here, it is
 * the difference between a recoverable failure and an unrecoverable one.
 *
 * The PIVOT is the first non-compensable step. Everything before it can be
 * rolled back; from it onward, failure leaves the world changed. That is the
 * only point in a plan where a human confirmation is worth interrupting for —
 * and confirming at every step instead is precisely the notification fatigue
 * ADR-027 §1 warns produces rubber-stamping.
 *
 * Scope: pure planning. The executor that runs a plan is P3-2's other half and
 * waits on the §5 integration question.
 */

export interface PlanStep {
  id: string;
  /** What it does, shown when asking a human to confirm crossing the pivot. */
  description: string;
  /**
   * Whether the step can be undone by a compensating action.
   *
   * REQUIRED and unforgiving by design. A default of "compensable" would let an
   * unannotated irreversible step sort early and be crossed without
   * confirmation — the failure this module exists to prevent.
   */
  compensable: boolean;
  /** Step ids that must run before this one. */
  dependsOn?: readonly string[];
}

export class PlanOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanOrderError';
  }
}

export interface OrderedPlan {
  steps: readonly PlanStep[];
  /**
   * Index of the first non-compensable step, or -1 when the whole plan is
   * reversible. Everything before it can be rolled back.
   */
  pivotIndex: number;
  /** The step at the pivot, when there is one. */
  pivot?: PlanStep;
  /** Steps that must complete before the pivot is crossed. */
  beforePivot: readonly PlanStep[];
  /** The pivot and everything after — the unrecoverable region. */
  afterPivot: readonly PlanStep[];
}

/**
 * Order a plan so non-compensable steps run as late as their dependencies
 * allow.
 *
 * A dependency-respecting topological sort that, among steps whose
 * prerequisites are satisfied, prefers compensable work first. Ties break on id
 * so the same plan always orders the same way — a plan that reshuffles between
 * runs cannot be checkpointed against or compared.
 *
 * Throws on a dependency cycle or an unknown dependency rather than dropping
 * the edge: a plan that silently ignores an ordering constraint is worse than
 * one that refuses to run, because the constraint existed for a reason.
 */
export function orderPlan(steps: readonly PlanStep[]): OrderedPlan {
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (byId.size !== steps.length) {
    const seen = new Set<string>();
    const dupe = steps.find((step) => seen.has(step.id) || (seen.add(step.id), false));
    throw new PlanOrderError(`Duplicate step id "${dupe?.id}"`);
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        throw new PlanOrderError(`Step "${step.id}" depends on unknown step "${dependency}"`);
      }
    }
  }

  const remaining = new Map(byId);
  const done = new Set<string>();
  const ordered: PlanStep[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((step) => (step.dependsOn ?? []).every((id) => done.has(id)))
      // Compensable first, then by id for determinism.
      .sort((a, b) => Number(a.compensable === false) - Number(b.compensable === false)
        || a.id.localeCompare(b.id));

    const next = ready[0];
    if (!next) {
      throw new PlanOrderError(
        `Dependency cycle among: ${[...remaining.keys()].sort().join(', ')}`,
      );
    }
    ordered.push(next);
    done.add(next.id);
    remaining.delete(next.id);
  }

  const pivotIndex = ordered.findIndex((step) => !step.compensable);
  return {
    steps: ordered,
    pivotIndex,
    ...(pivotIndex >= 0 ? { pivot: ordered[pivotIndex]! } : {}),
    beforePivot: pivotIndex >= 0 ? ordered.slice(0, pivotIndex) : ordered,
    afterPivot: pivotIndex >= 0 ? ordered.slice(pivotIndex) : [],
  };
}

/**
 * Steps to compensate, in reverse order, when a plan fails at `failedIndex`.
 *
 * Reverse because compensation must unwind: a later step may depend on an
 * earlier one's effect, so undoing the earlier one first can leave the later
 * compensation with nothing to act on.
 *
 * The failed step itself is NOT compensated. Whether its effect landed is
 * unknown — that is what failing means — so the caller must reconcile it by
 * idempotency key rather than assume either outcome.
 */
export function compensationOrder(plan: OrderedPlan, failedIndex: number): readonly PlanStep[] {
  if (failedIndex < 0 || failedIndex >= plan.steps.length) {
    throw new PlanOrderError(`failedIndex ${failedIndex} is outside the plan`);
  }
  return plan.steps
    .slice(0, failedIndex)
    .filter((step) => step.compensable)
    .reverse();
}

/**
 * Whether crossing the pivot needs a human, and what to tell them.
 *
 * Returns null for a fully reversible plan — the case where interrupting buys
 * nothing and spends attention that a later, real interrupt will need.
 */
export function pivotConfirmation(plan: OrderedPlan): { message: string; steps: readonly PlanStep[] } | null {
  if (plan.pivotIndex < 0) return null;
  const irreversible = plan.afterPivot.filter((step) => !step.compensable);
  const summary = irreversible.slice(0, 3).map((step) => step.description).join('; ');
  const more = irreversible.length > 3 ? ` and ${irreversible.length - 3} more` : '';
  return {
    message: `${plan.beforePivot.length} reversible step(s) will run first. `
      + `Then ${irreversible.length} step(s) that CANNOT be undone: ${summary}${more}.`,
    steps: irreversible,
  };
}
