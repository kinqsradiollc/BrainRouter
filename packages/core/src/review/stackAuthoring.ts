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
 *   `gh stack init`   — start a stack, or turn existing branches into one
 *   `gh stack add`    — create the next branch on top of the current stack
 *   `gh stack submit` — push branches and create/update the PRs, already linked
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
 * A value safe to pass as a positional argument to `gh`.
 *
 * The leading-hyphen check is the point. `^[A-Za-z0-9._\-\/]+$` looks
 * restrictive but matches `--force` and `-h`, and `gh` parses those as OPTIONS
 * rather than as the branch or ref they were meant to be. Branch names and refs
 * reach here from plan data the agent produced, so this is a real boundary, not
 * a theoretical one.
 *
 * `..` and a trailing `.lock` are rejected too — git refuses them, so a value
 * containing one is either a mistake or an attempt.
 */
export function isSafeArgument(value: string): boolean {
  if (!value || value.startsWith('-')) return false;
  if (value.includes('..') || value.endsWith('.lock')) return false;
  return /^[A-Za-z0-9._#\/-]+$/.test(value);
}

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
  if (!isSafeArgument(branch)) {
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

  // `--` stops option parsing, so even if the guard above is ever loosened a
  // hyphen-leading value is treated as the positional it was meant to be.
  const added = await runner.run(['add', '--', request.branch]);
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
 * Register branches that already exist as a stack.
 *
 * The path for work that was branched by hand before anyone thought of it as a
 * stack.
 *
 * The command is `gh stack init <branches...>`, NOT `gh stack link` — which is
 * what this called until someone ran it. The ADR was written from the feature
 * announcement rather than from `gh stack --help`, and a wrong subcommand fails
 * with a generic exit 1 that A3 classifies as `generic_error`, so nothing in
 * the design would have caught it. Reading the actual CLI did.
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
  const unsafe = [...refs, ...(base ? [base] : [])].filter((r) => !isSafeArgument(r));
  if (unsafe.length > 0) {
    return {
      linked: false,
      reason:
        `${unsafe.map((r) => `"${r}"`).join(', ')} ${unsafe.length === 1 ? 'is' : 'are'} not a usable pull-request reference. ` +
        'A value starting with "-" would be read as a command-line option rather than a reference.',
      outcome: { kind: 'invalid_arguments', exitCode: 5, ok: false, halts: false, unavailable: false, retryable: false, guidance: 'Unsafe ref.' },
    };
  }
  const result: StackRunResult = await runner.run([
    'init',
    ...(base ? ['--base', base] : []),
    '--',
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
