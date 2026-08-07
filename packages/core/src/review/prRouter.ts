/**
 * ADR-028 H1 — one create path, and it decides.
 *
 * The bug the owner reported: the desktop app and CLI agent still open ordinary
 * pull requests, despite Part A building capability detection, an exit-code
 * contract, a latching runner, a create path, sync, merge and a plan→stack
 * mapping. **Nothing routed through any of it.** Four independent
 * `gh pr create` call sites, none aware the stack machinery existed.
 *
 * That is the sixth instance of this ADR's own pattern and the largest — five
 * modules and eleven decisions reachable by nothing a user could do.
 *
 * This module is the missing decision. Every PR creation asks ONE question in
 * ONE place: should this be a stack? Then it routes.
 *
 * **Plain pull requests stay correct and common.** A one-file fix is not a
 * stack, and a router that stacks everything is worse than one that stacks
 * nothing — it would turn every change into five CI runs and five reviews. The
 * point is not to stack more; it is that the choice is made somewhere that has
 * both options, rather than in four places that each have one.
 */
import { adviseStacking, type StackAdvice } from './stackedPr.js';
import { proposeStackFromPlan, type PlanPhaseLike, type StackProposal } from './planToStack.js';
import type { StackCapability } from './stackCapability.js';

/**
 * How much the caller wants stacking attempted.
 *
 * `auto` is the default because someone who has never used stacks should not
 * have their first pull request silently become one. Making it opt-out rather
 * than opt-in would be a change to how their repository looks, decided by us.
 */
export type StackingMode = 'auto' | 'always' | 'never';

export interface PrRouteInput {
  mode: StackingMode;
  /** Present when `gh stack` is usable here (A1). */
  capability: StackCapability;
  /** The committed plan, when the work was planned (A7). */
  phases?: readonly PlanPhaseLike[];
  /** Total changed lines, for the unplanned-work path. */
  totalChangedLines?: number;
  /** Files grouped by unit of work, in dependency order. */
  groups?: ReadonlyArray<{ label: string; files: readonly string[]; changedLines: number }>;
}

export type PrRoute =
  | { kind: 'stack'; layers: readonly { phaseId: string; title: string; position: number }[]; rationale: string }
  | { kind: 'single'; reason: string };

/**
 * Decide how this change reaches the forge.
 *
 * Returns a route rather than performing it, so the decision is testable
 * without a git repository and so every caller lands on the same answer for the
 * same inputs — which is the property four independent call sites could not
 * have.
 */
export function routePullRequest(input: PrRouteInput): PrRoute {
  if (input.mode === 'never') {
    return { kind: 'single', reason: 'Stacking is turned off for this workspace.' };
  }

  if (!input.capability.available) {
    // Not an error and not worth a warning: a repository without the extension
    // opens ordinary pull requests, which is what it did yesterday.
    return {
      kind: 'single',
      reason: input.capability.reason ?? 'Stacked pull requests are not available here.',
    };
  }

  // A committed plan is the better signal, because its seams were RECORDED as
  // the work was written rather than inferred from a finished diff (A7).
  if (input.phases && input.phases.length > 0) {
    const proposal: StackProposal = proposeStackFromPlan(input.phases);
    if (proposal.stackable) {
      return {
        kind: 'stack',
        layers: proposal.layers.map((l) => ({ phaseId: l.phaseId, title: l.title, position: l.position })),
        rationale: proposal.rationale,
      };
    }
    if (input.mode === 'always') {
      // Even forced, an unstackable plan cannot become a stack: fan-out and
      // fan-in have no linear order, so inventing one would block layers for a
      // reason no reviewer could act on.
      return { kind: 'single', reason: proposal.reason };
    }
    return { kind: 'single', reason: proposal.reason };
  }

  // Unplanned work: fall back to inferring seams from the diff.
  if (typeof input.totalChangedLines === 'number' && input.groups) {
    const advice: StackAdvice = adviseStacking({
      totalChangedLines: input.totalChangedLines,
      groups: input.groups,
    });
    if (advice.shouldStack) {
      return {
        kind: 'stack',
        layers: advice.suggestedLayers.map((l, i) => ({
          phaseId: l.label, title: l.label, position: i + 1,
        })),
        rationale: advice.reason,
      };
    }
    return { kind: 'single', reason: advice.reason };
  }

  return {
    kind: 'single',
    reason: 'Nothing indicated this change is separable, so it opens as one pull request.',
  };
}

/**
 * The line shown when a route is chosen.
 *
 * Says WHY, both ways. A person who expected a stack and got one pull request
 * needs the reason more than the person who got what they expected — and a
 * silent route is how "why didn't it stack?" becomes a support question.
 */
export function describeRoute(route: PrRoute): string {
  if (route.kind === 'single') return `Opening one pull request — ${route.reason}`;
  return `Opening a ${route.layers.length}-layer stack — ${route.rationale}`;
}

/** Normalise a configured value; anything unrecognised falls back to `auto`. */
export function resolveStackingMode(raw: unknown): StackingMode {
  return raw === 'always' || raw === 'never' ? raw : 'auto';
}

/* ------------------------------------------------------------ H2 · the argv */

export interface ChangeRequestArgs {
  title: string;
  body: string;
  /** Open for review immediately rather than as a draft. */
  ready?: boolean;
  baseBranch?: string;
  /** The branch carrying the change, where the caller pushes before creating. */
  headBranch?: string;
}

/**
 * The exact `gh` argv for a routed change request.
 *
 * H2's remaining half. The ROUTE was already decided once by
 * `routePullRequest`, but each call site still assembled its own command — and
 * the argv is precisely what drifts. `gh stack link` shipped and survived a
 * ten-code exit contract, a latching runner and fourteen tests, because an
 * unknown subcommand exits 1 exactly like a real command that failed. Nothing
 * downstream can tell you that you invented a verb; only building the argv in
 * one place can.
 *
 * Returns argv, not a spawned process: the surfaces genuinely differ in how
 * they run commands (an Electron helper, a CLI runner, a worktree-scoped
 * child), and forcing one runner would be a worse coupling than the
 * duplication it removes.
 */
export function changeRequestArgv(route: PrRoute, args: ChangeRequestArgs): string[] {
  if (route.kind === 'stack') {
    // `submit` publishes the whole chain; `--auto` links the PRs into the stack
    // on GitHub rather than leaving branches that merely target each other.
    return ['stack', 'submit', '--auto', ...(args.ready ? ['--open'] : [])];
  }
  return [
    'pr', 'create',
    ...(args.ready ? [] : ['--draft']),
    ...(args.baseBranch ? ['--base', args.baseBranch] : []),
    // `--head` only where the caller pushed a branch it must name. Passing it
    // from a checkout that is already on that branch is redundant, and `gh`
    // rejects it against a base it cannot resolve.
    ...(args.headBranch ? ['--head', args.headBranch] : []),
    '--title', args.title,
    '--body', args.body,
  ];
}

/** How long the routed command may take. A stack submit is not a `pr create`. */
export function changeRequestTimeoutMs(route: PrRoute): number {
  // Publishing a chain pushes every branch and opens every PR; 20s is a plain
  // create's budget and would report a working submit as a failure.
  return route.kind === 'stack' ? 120_000 : 20_000;
}
