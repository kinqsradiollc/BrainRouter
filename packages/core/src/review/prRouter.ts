/**
 * ADR-028 H1/H2 — one create path, and the argv it produces.
 *
 * Every pull request BrainRouter opens is assembled here: the decision (stack
 * or plain) in `routePullRequest`, the command in `changeRequestArgv`. Four
 * call sites each building their own `gh pr create` is how the stack machinery
 * stayed unreachable, and the argv is what drifts — `gh stack link` shipped and
 * survived a ten-code exit contract because an unknown subcommand exits 1
 * exactly like a real command that failed.
 *
 * **What this router no longer does: propose a stack.** ADR-028 A2/A7 designed
 * a create path that authored layers — one plan phase per layer — and an
 * inference that split an unplanned diff into seams. Neither shipped, and both
 * are retired rather than finished, because the surfaces that would have to
 * author the layers cannot: the build-loop emit delivers one squashed patch on
 * one branch, and there is no per-phase patch to lay down as layer 2. A router
 * that answered "stack" there would name a five-layer chain and produce one
 * pull request.
 *
 * So stacks are the USER's: `gh stack` creates them, and `cli.stackingMode:
 * "always"` tells us to publish through `gh stack submit` instead of
 * `gh pr create`. We read stacks (`stackedPr.ts`, the brain's PR review) and we
 * submit into one. We do not create, sync or merge them.
 */
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
}

export type PrRoute =
  | { kind: 'stack'; reason: string }
  | { kind: 'single'; reason: string };

/**
 * Decide how this change reaches the forge.
 *
 * Returns a route rather than performing it, so the decision is testable
 * without a git repository and so every caller lands on the same answer for the
 * same inputs — which is the property four independent call sites could not
 * have.
 *
 * `always` is the only route to a stack, and it only means one thing: submit
 * through `gh stack`, which publishes the stack this checkout is already part
 * of. If it is not part of one, `gh stack submit` says so and nothing is
 * created — a loud, correct failure, rather than a plain pull request reported
 * as a layer.
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

  if (input.mode === 'always') {
    return {
      kind: 'stack',
      reason:
        'Stacking is set to `always`, so this is submitted through `gh stack` — it publishes the ' +
        'stack this branch is part of rather than opening a pull request beside it.',
    };
  }

  return {
    kind: 'single',
    reason:
      'Stacking is `auto`, and BrainRouter does not decide on its own that a change should become a ' +
      'stack. Create one with `gh stack` and set `cli.stackingMode` to `always` to publish through it.',
  };
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
