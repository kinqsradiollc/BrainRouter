/**
 * ADR-028 A7 — plan phases are the stack.
 *
 * The central decision in this ADR, and it is mostly an act of noticing. The
 * agent already commits to an ordered plan before it writes code:
 * a phase carries an id, a title, and `dependsOn`. That is a
 * dependency graph, produced as the work is planned — and today it is thrown
 * away once the phases finish.
 *
 *     One plan phase → one layer → one pull request, authored as the work happens.
 *
 * Post-hoc splitting (`adviseStacking`) stays as the fallback for unplanned
 * work, and it is strictly worse: seams have to be INFERRED from a finished
 * diff rather than RECORDED as it is written, and an inferred seam is a guess
 * about intent.
 *
 * The one real obstacle: a plan is a DAG and a stack is a chain. Phases with no
 * dependency between them are independent work, and pretending otherwise
 * produces a stack whose ordering is arbitrary — layer 3 blocked behind layer 2
 * for no reason anyone can explain. So this linearises only where the graph
 * genuinely is a chain, and says so plainly where it is not.
 */
import { DEFAULT_MAX_STACK_DEPTH } from './stackAuthoring.js';

/**
 * The part of a plan phase a stack needs.
 *
 * Structural rather than importing `StoredPlanPhase`, so this stays usable for
 * anything that produces ordered work with dependencies — and so a change to
 * the plan schema does not reach in here.
 */
export interface PlanPhaseLike {
  id: string;
  title: string;
  status?: string;
  dependsOn?: readonly string[];
}

export interface ProposedLayer {
  phaseId: string;
  title: string;
  /** Position from the bottom, 1-based. */
  position: number;
  /** The phase directly beneath, when there is one. */
  dependsOnPhaseId?: string;
}

export type StackProposal =
  | {
      stackable: true;
      layers: readonly ProposedLayer[];
      /** Why this is worth doing, in the words shown to the human. */
      rationale: string;
    }
  | { stackable: false; reason: string };

/**
 * Turn a committed plan into a proposed stack.
 *
 * Refuses more often than it accepts, deliberately. A stack proposal that
 * arrives for every plan is dismissed reflexively, and then it is worth nothing
 * on the plan where it mattered.
 */
export function proposeStackFromPlan(
  phases: readonly PlanPhaseLike[],
  opts: { maxDepth?: number } = {},
): StackProposal {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_STACK_DEPTH;
  const live = phases.filter((p) => p.status !== 'skipped');

  if (live.length < 2) {
    return {
      stackable: false,
      reason: 'A plan with one phase is one pull request.',
    };
  }
  if (live.length > maxDepth) {
    return {
      stackable: false,
      reason:
        `This plan has ${live.length} phases, past the ${maxDepth}-layer cap. Beyond it a stack ` +
        'stops being an ordered series of decisions and becomes a queue, with a CI run attached ' +
        'to each. Consider stacking the first few and following up with the rest.',
    };
  }

  const ids = new Set(live.map((p) => p.id));
  const chain = linearise(live, ids);
  if (!chain.ok) {
    return { stackable: false, reason: chain.reason };
  }

  const layers = chain.order.map((phase, index): ProposedLayer => ({
    phaseId: phase.id,
    title: phase.title,
    position: index + 1,
    ...(index > 0 ? { dependsOnPhaseId: chain.order[index - 1]!.id } : {}),
  }));

  return {
    stackable: true,
    layers,
    rationale:
      `These ${layers.length} phases form a chain — each builds on the one before it — so they map ` +
      'onto a stack of the same shape. Each layer is reviewable on its own, and the reviewer ' +
      'decides once per phase instead of once for the whole change.',
  };
}

/**
 * Order phases into a chain, or explain why they are not one.
 *
 * A valid stack requires each phase to depend on exactly the phase beneath it.
 * Two phases at the same depth are parallel work: they can be reviewed and
 * merged in either order, and forcing one behind the other invents a
 * constraint that will confuse whoever tries to land them.
 */
function linearise(
  phases: readonly PlanPhaseLike[],
  known: ReadonlySet<string>,
): { ok: true; order: readonly PlanPhaseLike[] } | { ok: false; reason: string } {
  // Dependencies on phases outside this set (already merged, or skipped) carry
  // no ordering information here.
  const deps = new Map(
    phases.map((p) => [p.id, (p.dependsOn ?? []).filter((d: string) => known.has(d) && d !== p.id)]),
  );

  const roots = phases.filter((p) => deps.get(p.id)!.length === 0);
  if (roots.length === 0) {
    return { ok: false, reason: 'These phases depend on each other in a cycle, which cannot be ordered.' };
  }
  if (roots.length > 1) {
    return {
      ok: false,
      reason:
        `${roots.map((r) => `"${r.title}"`).join(' and ')} do not depend on anything, so they are ` +
        'independent work. Stacking them would put one behind the other for no reason a reviewer ' +
        'could act on — they belong in separate pull requests.',
    };
  }

  const order: PlanPhaseLike[] = [];
  const placed = new Set<string>();
  let current: PlanPhaseLike | undefined = roots[0];

  while (current) {
    order.push(current);
    placed.add(current.id);
    const next = phases.filter(
      (p) => !placed.has(p.id) && deps.get(p.id)!.length === 1 && deps.get(p.id)![0] === current!.id,
    );
    if (next.length > 1) {
      return {
        ok: false,
        reason:
          `${next.map((n) => `"${n.title}"`).join(' and ')} both build directly on "${current.title}", ` +
          'so they are parallel rather than stacked. Either order would be arbitrary.',
      };
    }
    current = next[0];
  }

  if (order.length !== phases.length) {
    const stranded = phases.filter((p) => !placed.has(p.id));
    return {
      ok: false,
      reason:
        `${stranded.map((p) => `"${p.title}"`).join(', ')} depend${stranded.length === 1 ? 's' : ''} on ` +
        'more than one phase, which a stack cannot express — a layer has exactly one layer beneath it.',
    };
  }

  return { ok: true, order };
}

/* --------------------------------------------------------- auto-proposal */

export interface ProposalGateState {
  /** Ids of changes we have already proposed for. */
  proposedFor: ReadonlySet<string>;
  /** True once the human has declined a proposal in this session. */
  declined: boolean;
}

/**
 * May the agent raise a stack proposal unprompted?
 *
 * ADR-027 §1 measured notification acceptance falling roughly 30% per
 * notification. A proposal that fires often is dismissed reflexively, and by
 * the time one matters the reflex is established — so this fires once per
 * change and never again after a decline.
 *
 * The decline is session-wide rather than per-change on purpose: a person who
 * declines once has told us how they work, and asking again about a different
 * change ignores that.
 */
export function mayProposeStack(
  gate: ProposalGateState,
  changeId: string,
  advice: { shouldStack: boolean },
): { propose: boolean; reason?: string } {
  if (gate.declined) {
    return { propose: false, reason: 'A stack proposal was declined; not asking again this session.' };
  }
  if (gate.proposedFor.has(changeId)) {
    return { propose: false, reason: 'Already proposed for this change.' };
  }
  if (!advice.shouldStack) {
    return { propose: false, reason: 'The change is within the reviewable band, or is indivisible.' };
  }
  return { propose: true };
}
