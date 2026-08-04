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
  /** The layers whose history was rewritten, for the activity record. */
  rewrote?: readonly LayerState[];
}

/**
 * The list a sync confirmation must show.
 *
 * Syncing rewrites the history of every layer above the one that changed, and
 * those branches already carry review comments. Consent to "sync the stack" is
 * not consent to rewrite six branches you had forgotten were in it — so the
 * confirmation names them, rather than being a dialog to click past.
 */
export function describeSyncRewrite(rewrites: readonly LayerState[]): string {
  if (rewrites.length === 0) return 'No branch history will be rewritten.';
  const list = rewrites.map((l) => `#${l.number}`).join(', ');
  return (
    `This rewrites the history of ${rewrites.length} branch${rewrites.length === 1 ? '' : 'es'}: ${list}. ` +
    'Review comments on rewritten commits may become detached.'
  );
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
export async function syncStack(
  runner: StackRunner,
  opts: { rewrites?: readonly LayerState[] } = {},
): Promise<SyncResult> {
  const result = await runner.run(
    [
      'sync',
      // Rebasing rewrites commit dates, which makes review comments appear to
      // predate the code they are about. Preserving the author date keeps the
      // review record legible.
      '--committer-date-is-author-date',
    ],
    { timeoutMs: 120_000 },
  );
  const { outcome } = result;

  if (outcome.ok) {
    return { synced: true, needsHuman: false, outcome, rewrote: opts.rewrites ?? [] };
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
 * What actually lands when someone asks to merge a given layer?
 *
 * `gh stack merge <layer>` merges that layer **and everything beneath it**. The
 * operation is all-or-nothing, and that is the thing a confirmation has to say:
 * "Merge #12" which silently lands #9, #10 and #11 has not obtained consent for
 * what happens. So this returns the full cascade rather than a bare yes, and
 * the caller is expected to name every number in it.
 *
 * Every layer in the cascade must be ready, not just the target. One unready
 * layer below makes the whole merge illegal — there is no partial outcome to
 * fall back to.
 */
export interface MergeCascade {
  allowed: boolean;
  /** Every PR that lands, bottom-first. Name all of these in the confirmation. */
  landing: readonly LayerState[];
  reason?: string;
  /** True when the blocker is expected to clear on its own. */
  waiting?: boolean;
}

export function planMergeCascade(
  layers: readonly LayerState[],
  targetNumber: number,
): MergeCascade {
  const target = layers.find((l) => l.number === targetNumber);
  if (!target) {
    return { allowed: false, landing: [], reason: `#${targetNumber} is not part of this stack.` };
  }
  if (target.merged) {
    return { allowed: false, landing: [], reason: `#${targetNumber} has already merged.` };
  }

  const landing = layers
    .filter((l) => l.position <= target.position && !l.merged)
    .sort((a, b) => a.position - b.position);

  const queued = landing.filter((l) => l.inMergeQueue);
  if (queued.length > 0) {
    return {
      allowed: false,
      landing,
      waiting: true,
      reason:
        `${queued.map((l) => `#${l.number}`).join(', ')} ${queued.length === 1 ? 'is' : 'are'} in GitHub's merge queue. ` +
        'The queue decides when they land; merging around it would skip the checks it exists to run.',
    };
  }

  const notReady = landing.filter((l) => !l.checksPassed || !l.approved);
  if (notReady.length > 0) {
    const detail = notReady
      .map((l) => `#${l.number} (${!l.checksPassed ? 'checks not passed' : 'not approved'})`)
      .join(', ');
    return {
      allowed: false,
      landing,
      waiting: true,
      reason:
        `Merging #${targetNumber} lands ${landing.map((l) => `#${l.number}`).join(', ')} together, and ` +
        `${detail} ${notReady.length === 1 ? 'is' : 'are'} not ready. The merge is all-or-nothing — ` +
        'there is no partial outcome where the ready ones land and the rest wait.',
    };
  }

  return { allowed: true, landing };
}

/**
 * The sentence a confirmation must show.
 *
 * Kept next to the cascade so no caller can display a confirmation that names
 * fewer pull requests than the operation lands.
 */
export function describeMergeCascade(cascade: MergeCascade): string {
  const list = cascade.landing.map((l) => `#${l.number}`).join(', ');
  if (cascade.landing.length <= 1) return `This merges ${list || 'nothing'}.`;
  return `This merges ${cascade.landing.length} pull requests together, bottom-first: ${list}. They land as one operation.`;
}

/**
 * Which layers are left stranded by a merge that did not reach the top?
 *
 * After a mid-stack merge the layers above are rebased onto the new trunk by
 * GitHub, but our local branches are not. Reporting them is the difference
 * between "your stack now has three layers" and a later `submit` pushing
 * commits that already merged.
 */
export function staleAfterMerge(
  layers: readonly LayerState[],
  landed: readonly number[],
): readonly LayerState[] {
  const set = new Set(landed);
  return layers.filter((l) => !set.has(l.number) && !l.merged);
}

export interface MergeResult {
  merged: boolean;
  /** Still in flight or expected to clear — NOT a failure. */
  pending: boolean;
  /** Every PR that landed, when it landed. */
  landed: readonly number[];
  /** Local layers left behind by a merge that did not reach the top. */
  stale: readonly LayerState[];
  reason?: string;
  outcome?: StackOutcome;
}

/**
 * Stack merges routinely take 90 seconds or more through GitHub's API.
 *
 * A short timeout produces a spurious failure on an operation that is
 * succeeding, and the natural response to a spurious failure — retry — runs
 * against a partially-applied merge. That is the worst available outcome, so
 * the timeout is generous and a timeout is reported as pending, never failed.
 */
export const MERGE_TIMEOUT_MS = 300_000;

/**
 * Merge a layer and everything beneath it.
 *
 * Takes the cascade rather than re-deriving it, so what runs is exactly what
 * the confirmation described. `gh stack merge` retargets the layers above as
 * part of landing; a plain `gh pr merge` does not.
 */
export async function mergeStackThrough(
  runner: StackRunner,
  layers: readonly LayerState[],
  targetNumber: number,
): Promise<MergeResult> {
  const cascade = planMergeCascade(layers, targetNumber);
  if (!cascade.allowed) {
    return {
      merged: false,
      pending: cascade.waiting ?? false,
      landed: [],
      stale: [],
      reason: cascade.reason,
    };
  }

  const result = await runner.run(['merge', String(targetNumber)], {
    timeoutMs: MERGE_TIMEOUT_MS,
  });

  if (result.outcome.ok) {
    const landed = cascade.landing.map((l) => l.number);
    return {
      merged: true,
      pending: false,
      landed,
      // Detected and reported rather than silently left: a later `submit` on a
      // stale branch pushes commits that already merged.
      stale: staleAfterMerge(layers, landed),
      outcome: result.outcome,
    };
  }

  if (result.outcome.kind === 'stack_locked' || result.outcome.retryable) {
    // A race we lost, or a transient API failure. Neither means the merge is
    // wrong — and both are safe to observe before acting.
    return {
      merged: false,
      pending: true,
      landed: [],
      stale: [],
      reason:
        `${result.outcome.guidance} Check the stack before retrying — a merge that took longer ` +
        'than expected may still have landed.',
      outcome: result.outcome,
    };
  }

  return {
    merged: false,
    pending: false,
    landed: [],
    stale: [],
    reason: result.outcome.guidance,
    outcome: result.outcome,
  };
}
