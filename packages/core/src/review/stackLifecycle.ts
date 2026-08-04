/**
 * ADR-028 A4 (sync) and A5 (merge) — the two mutations that can lose work.
 *
 * Both share one shape: decide whether the operation is legal BEFORE running it,
 * because both have a failure mode that is expensive to undo. A sync that hits a
 * conflict leaves a half-rebased tree; a merge taken out of order breaks every
 * layer above it. Neither is recoverable by retrying, which is exactly what an
 * agent does when a command merely fails.
 */
import type { StackRunner } from './stackRunner.js';
import type { StackOutcome } from './stackExitCodes.js';

/* ------------------------------------------------------------------ A4 sync */

export interface SyncResult {
  synced: boolean;
  /** True when a human has to resolve a conflict before anything else runs. */
  needsHuman: boolean;
  reason?: string;
  outcome: StackOutcome;
}

/**
 * Restack the layers above whatever changed below them.
 *
 * Needed after the bottom layer merges, after review changes land in a middle
 * layer, and after trunk moves. GitHub retargets the pull requests on its side;
 * `gh stack sync` is what makes the local branches match, and without it the
 * next `submit` pushes commits that were already merged.
 *
 * A conflict is NOT a failure to retry. It leaves a rebase in progress, and a
 * second command run on that tree compounds it into a state where the original
 * work is genuinely hard to recover. The runner latches; this reports the latch
 * in words that say what to do.
 */
export async function syncStack(runner: StackRunner): Promise<SyncResult> {
  const result = await runner.run(['sync'], { timeoutMs: 120_000 });
  const { outcome } = result;

  if (outcome.ok) {
    return { synced: true, needsHuman: false, outcome };
  }

  if (outcome.kind === 'rebase_conflict' || outcome.kind === 'rebase_in_progress') {
    return {
      synced: false,
      needsHuman: true,
      reason:
        'The restack hit a conflict, and the working tree is mid-rebase. Resolve it and run ' +
        '`git rebase --continue`, or `git rebase --abort` to back out. Stack commands stay ' +
        'blocked until then — running another one now would build on a half-finished tree.',
      outcome,
    };
  }

  if (outcome.kind === 'recovery_needed') {
    return {
      synced: false,
      needsHuman: true,
      reason:
        'The stack is in a state `gh stack` will not resolve on its own. Run `gh stack view` to ' +
        'see it before changing anything — guessing here is how commits get lost.',
      outcome,
    };
  }

  return { synced: false, needsHuman: false, reason: outcome.guidance, outcome };
}

/* ----------------------------------------------------------------- A5 merge */

export interface LayerState {
  number: number;
  /** Position from the bottom, 1-based. The bottom layer targets trunk. */
  position: number;
  merged: boolean;
  /** Every required check has concluded successfully. */
  checksPassed: boolean;
  /** Approved, and no review is requesting changes. */
  approved: boolean;
  /** GitHub has this queued; the outcome is not ours to decide. */
  inMergeQueue?: boolean;
}

export type MergeDecision =
  | { allowed: true; layer: LayerState }
  | { allowed: false; reason: string; waiting: boolean };

/**
 * Which layer, if any, may merge right now?
 *
 * Stacks merge bottom-up, and this is not a convention — it is the only order
 * that works. Merging a middle layer leaves the layers below it unmerged while
 * their commits are already on trunk, which GitHub resolves by making the lower
 * pull requests look empty. The work is not lost, but the review record is, and
 * that is the thing a stack exists to preserve.
 *
 * `waiting` distinguishes "not yet" from "no". A caller that treats a queued
 * merge as a refusal will report failure for something that is proceeding
 * normally, and an agent that reads it as failure will try to force it.
 */
export function selectMergeableLayer(layers: readonly LayerState[]): MergeDecision {
  const ordered = [...layers].sort((a, b) => a.position - b.position);
  const next = ordered.find((l) => !l.merged);

  if (!next) {
    return { allowed: false, reason: 'Every layer in this stack has merged.', waiting: false };
  }

  if (next.inMergeQueue) {
    return {
      allowed: false,
      waiting: true,
      reason:
        `Layer #${next.number} is in GitHub's merge queue. The queue decides when it lands — ` +
        'merging around it would skip the checks the queue exists to run.',
    };
  }

  if (!next.checksPassed) {
    return {
      allowed: false,
      waiting: true,
      reason: `Layer #${next.number} has checks that have not passed. It is the bottom unmerged layer, so nothing above it can merge either.`,
    };
  }

  if (!next.approved) {
    return {
      allowed: false,
      waiting: true,
      reason: `Layer #${next.number} is not approved yet.`,
    };
  }

  return { allowed: true, layer: next };
}

/**
 * Is a layer above the bottom being asked to merge on its own?
 *
 * Separate from `selectMergeableLayer` because this answers a different
 * question: not "what is next" but "is this specific request legal". The desktop
 * merge button on a middle layer takes this path, and it needs to say why, not
 * merely refuse.
 */
export function validateMergeTarget(
  layers: readonly LayerState[],
  targetNumber: number,
): { allowed: boolean; reason?: string } {
  const target = layers.find((l) => l.number === targetNumber);
  if (!target) {
    return { allowed: false, reason: `#${targetNumber} is not part of this stack.` };
  }
  if (target.merged) {
    return { allowed: false, reason: `#${targetNumber} has already merged.` };
  }
  const below = layers.filter((l) => l.position < target.position && !l.merged);
  if (below.length > 0) {
    const list = below.map((l) => `#${l.number}`).join(', ');
    return {
      allowed: false,
      reason:
        `${list} ${below.length === 1 ? 'is' : 'are'} below #${targetNumber} and ${below.length === 1 ? 'has' : 'have'} not merged. ` +
        'Stacks merge bottom-up: landing this one first would put its commits on trunk while the ' +
        `pull request${below.length === 1 ? '' : 's'} below still claim${below.length === 1 ? 's' : ''} to contain them, and the review record for that work is what gets lost.`,
    };
  }
  return { allowed: true };
}

export interface MergeResult {
  merged: boolean;
  queued: boolean;
  reason?: string;
  outcome?: StackOutcome;
}

/**
 * Merge the bottom layer.
 *
 * Delegates the ordering decision rather than re-deriving it, then delegates the
 * merge itself to `gh stack merge` — which retargets the layers above as part of
 * landing, something a plain `gh pr merge` does not do.
 */
export async function mergeBottomLayer(
  runner: StackRunner,
  layers: readonly LayerState[],
): Promise<MergeResult> {
  const decision = selectMergeableLayer(layers);
  if (!decision.allowed) {
    return { merged: false, queued: decision.waiting, reason: decision.reason };
  }

  const result = await runner.run(['merge', String(decision.layer.number)], {
    timeoutMs: 120_000,
  });

  if (result.outcome.ok) {
    return { merged: true, queued: false, outcome: result.outcome };
  }
  if (result.outcome.kind === 'stack_locked') {
    // Someone else is mutating the stack. Not an error — a race we lost.
    return {
      merged: false,
      queued: true,
      reason: 'Another operation holds this stack. It is safe to try again shortly.',
      outcome: result.outcome,
    };
  }
  return { merged: false, queued: false, reason: result.outcome.guidance, outcome: result.outcome };
}
