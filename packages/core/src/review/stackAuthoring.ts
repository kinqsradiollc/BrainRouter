/**
 * ADR-028 S2-2 — creating a layer that is genuinely part of a stack.
 *
 * This replaces the removed `stack.addlayer` (A2), which called
 * `gh api repos/{repo}/pulls` and produced a pull request that merely TARGETED
 * the branch below. The difference is not cosmetic: a targeted PR has no stack
 * object, no bottom-up merge, and no auto-retarget, so every downstream promise
 * of the feature silently fails.
 *
 * Two real paths, matching the CLI:
 *
 *   `gh stack add`    — create the next branch on top of the current stack
 *   `gh stack submit` — push branches and create/update the PRs, already linked
 *   `gh stack link`   — register pull requests that already exist
 *
 * A3's outcomes decide what happened; S2-1's runner enforces capability and the
 * halt latch. Nothing here re-interprets an exit code.
 */
import type { StackRunner, StackRunResult } from './stackRunner.js';
import type { StackOutcome } from './stackExitCodes.js';

export interface LayerCreationRequest {
  /** Branch name for the new layer. */
  branch: string;
  /** Title for its pull request. */
  title: string;
  /** Body. A7 requires this to state the dependency in prose. */
  body: string;
  /** Open for review immediately rather than as a draft. */
  ready?: boolean;
}

export type LayerCreationResult =
  | { created: true; branch: string; outcome: StackOutcome }
  | { created: false; reason: string; outcome?: StackOutcome };

/**
 * Reject a request that would produce a layer nobody can review.
 *
 * A7 requires each layer's body to state what it depends on, in prose. "Layer 3
 * of 5" is navigation; "this needs the schema from #41 before the API can read
 * it" is the dependency, and it is the sentence that makes the layer reviewable
 * on its own. A body that is only a title restated fails that, so it is refused
 * at the boundary rather than discovered by a reviewer.
 */
export function validateLayerRequest(request: LayerCreationRequest): string | null {
  const branch = request.branch?.trim() ?? '';
  const title = request.title?.trim() ?? '';
  const body = request.body?.trim() ?? '';
  if (!branch) return 'A branch name is required.';
  if (!/^[A-Za-z0-9._\-\/]+$/.test(branch)) {
    return `"${branch}" is not a usable branch name.`;
  }
  if (!title) return 'A title is required.';
  if (body.length < 20) {
    return (
      'The body must state what this layer depends on and why, in prose. ' +
      '"Layer 3 of 5" is navigation, not a dependency — a reviewer opening this ' +
      'layer alone needs to know what it builds on.'
    );
  }
  return null;
}

/**
 * Add a layer on top of the current stack and submit it.
 *
 * `add` then `submit`, because `add` creates the branch locally and `submit` is
 * what registers the pull request into the stack on GitHub. Doing only the
 * first leaves a branch nobody can review; doing only the second has nothing to
 * push. The two-step is why the old single API call could never have worked.
 */
export async function addStackLayer(
  runner: StackRunner,
  request: LayerCreationRequest,
): Promise<LayerCreationResult> {
  const invalid = validateLayerRequest(request);
  if (invalid) return { created: false, reason: invalid };

  const added = await runner.run(['add', request.branch]);
  if (!added.outcome.ok) {
    return {
      created: false,
      reason: `Could not create the layer branch: ${added.outcome.guidance}`,
      outcome: added.outcome,
    };
  }

  const submitted = await runner.run([
    'submit',
    '--auto',
    ...(request.ready ? ['--open'] : []),
  ], { timeoutMs: 60_000 });

  if (!submitted.outcome.ok) {
    // The branch exists but the pull request does not. Say exactly that — the
    // half-done state is recoverable and the human needs to know which half.
    return {
      created: false,
      reason:
        `The branch "${request.branch}" was created but submitting the pull request failed: ` +
        `${submitted.outcome.guidance} The branch is still there; re-run submit once the cause is cleared.`,
      outcome: submitted.outcome,
    };
  }

  return { created: true, branch: request.branch, outcome: submitted.outcome };
}

/**
 * Register pull requests that already exist as a stack.
 *
 * The path for work that was branched and opened by hand before anyone thought
 * of it as a stack.
 */
export async function linkExistingIntoStack(
  runner: StackRunner,
  refs: readonly string[],
  base?: string,
): Promise<{ linked: boolean; reason?: string; outcome: StackOutcome }> {
  if (refs.length < 2) {
    return {
      linked: false,
      reason: 'A stack needs at least two pull requests; one is just a pull request.',
      outcome: { kind: 'invalid_arguments', exitCode: 5, ok: false, halts: false, unavailable: false, retryable: false, guidance: 'Fewer than two refs.' },
    };
  }
  const result: StackRunResult = await runner.run([
    'link',
    ...(base ? ['--base', base] : []),
    ...refs,
  ]);
  return result.outcome.ok
    ? { linked: true, outcome: result.outcome }
    : { linked: false, reason: result.outcome.guidance, outcome: result.outcome };
}

/**
 * May another layer be added?
 *
 * A7's two authoring guards, checked before creating rather than discovered
 * afterwards:
 *
 *  - **Depth.** Past the cap a stack stops being an ordered series of decisions
 *    and becomes a queue. Fifteen layers is less reviewable than one large pull
 *    request, with fifteen CI runs attached.
 *  - **Never on a broken base.** If the layer below failed its checks, anything
 *    above it cannot land anyway. Enforcing it here — rather than at merge —
 *    stops the agent building four layers on a foundation that will never merge.
 */
export const DEFAULT_MAX_STACK_DEPTH = 5;

export function canAddLayer(input: {
  currentDepth: number;
  baseLayerReady: boolean;
  maxDepth?: number;
}): { allowed: boolean; reason?: string } {
  const max = input.maxDepth ?? DEFAULT_MAX_STACK_DEPTH;
  if (!input.baseLayerReady) {
    return {
      allowed: false,
      reason:
        'The layer below has not passed its checks. Anything stacked on it cannot merge until it ' +
        'does, so building further would produce layers that are blocked by construction.',
    };
  }
  if (input.currentDepth >= max) {
    return {
      allowed: false,
      reason:
        `This stack already has ${input.currentDepth} layers (cap ${max}). Past this a stack stops ` +
        'being an ordered series of decisions and becomes a queue — consider landing these first ' +
        'and starting a follow-on stack.',
    };
  }
  return { allowed: true };
}
