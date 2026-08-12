/**
 * ADR-027 D13 — stacked pull requests.
 *
 * GitHub put stacked PRs into public preview on 2026-07-30. A stack is an
 * ORDERED chain: the bottom layer targets the trunk, and every layer above
 * targets the branch of the layer below it. Merging happens bottom-up; merging
 * a middle layer lands everything beneath it, and the layers above are rebased
 * and re-targeted automatically.
 *
 * WHY THIS BELONGS IN THIS ADR rather than being a nice-to-have integration.
 * §1 records that on agent-authored work, PR size and files-per-PR are up,
 * time-in-review is up several-fold, PRs merged with no review are up sharply,
 * and reviewer comments are markedly less substantive. D1's answer to cognitive
 * debt is to keep the human deciding at a **decision granularity** rather than
 * an action granularity. A stack is exactly that: it converts one 2,000-line
 * "approve or don't" into an ordered series of reviewable decisions, without
 * asking the author to invent artificial commits or the reviewer to hold the
 * whole change in their head at once.
 *
 * This module is the part that must be OURS rather than GitHub's: the ordering
 * and merge-readiness rules that our review gate needs in order to say
 * something true about a layer whose mergeability depends on layers below it.
 * Getting that wrong produces the most corrosive possible output — a green
 * check on something that cannot merge, or a red one on something whose only
 * problem is that someone else's layer is still open.
 */

export interface StackLayer {
  /** Pull request number. */
  number: number;
  /** Head branch of this layer. */
  head: string;
  /** Branch this layer targets — the layer below, or the trunk for the bottom. */
  base: string;
  /** Approximate size, used for the granularity advice below. */
  changedLines?: number;
  /** Whether this layer's own checks and review permit it to merge. */
  ready: boolean;
  /** Already merged (a stack can be partially landed). */
  merged?: boolean;
}

export interface PullRequestStack {
  /** The branch the bottom layer targets. */
  trunk: string;
  /** Bottom-first. Order is meaningful and is validated. */
  layers: readonly StackLayer[];
}

export class StackError extends Error {
  constructor(message: string, readonly code:
    | 'not_linear'
    | 'wrong_trunk'
    | 'duplicate_layer'
    | 'cycle'
    | 'merged_above_unmerged') {
    super(message);
    this.name = 'StackError';
  }
}

/**
 * Validate the structural invariants of a stack.
 *
 * These are checked rather than assumed because every downstream answer —
 * what can merge, what to review, what to report — is nonsense if the chain is
 * not actually a chain.
 */
export function validateStack(stack: PullRequestStack): void {
  const { trunk, layers } = stack;
  if (layers.length === 0) return;

  const seenNumbers = new Set<number>();
  const seenHeads = new Set<string>();
  for (const layer of layers) {
    if (seenNumbers.has(layer.number)) {
      throw new StackError(`Pull request #${layer.number} appears twice in the stack.`, 'duplicate_layer');
    }
    if (seenHeads.has(layer.head)) {
      throw new StackError(`Branch "${layer.head}" appears twice in the stack.`, 'duplicate_layer');
    }
    if (layer.head === layer.base) {
      throw new StackError(`#${layer.number} targets its own branch "${layer.head}".`, 'cycle');
    }
    seenNumbers.add(layer.number);
    seenHeads.add(layer.head);
  }

  if (layers[0]!.base !== trunk) {
    throw new StackError(
      `The bottom layer #${layers[0]!.number} targets "${layers[0]!.base}", not the trunk "${trunk}".`,
      'wrong_trunk',
    );
  }
  for (let i = 1; i < layers.length; i += 1) {
    const below = layers[i - 1]!;
    const layer = layers[i]!;
    if (layer.base !== below.head) {
      throw new StackError(
        `#${layer.number} targets "${layer.base}" but the layer below it (#${below.number}) ` +
        `is on "${below.head}". A stack is a chain; a layer that targets somewhere else is ` +
        'not part of it, and treating it as though it were would report merge order wrongly.',
        'not_linear',
      );
    }
  }

  // A merged layer above an unmerged one contradicts bottom-up merging, and
  // usually means the caller assembled the stack in the wrong order.
  let sawUnmerged = false;
  for (const layer of layers) {
    if (!layer.merged) sawUnmerged = true;
    else if (sawUnmerged) {
      throw new StackError(
        `#${layer.number} is merged but a layer below it is not. Stacks merge bottom-up, ` +
        'so this ordering cannot have happened — the layers are probably out of order.',
        'merged_above_unmerged',
      );
    }
  }
}

export type LayerBlockReason =
  | { kind: 'ready' }
  | { kind: 'already_merged' }
  | { kind: 'own_checks' }
  | { kind: 'blocked_below'; by: number };

export interface LayerMergeVerdict {
  number: number;
  mergeable: boolean;
  reason: LayerBlockReason;
  /** Layers that would land with this one, bottom-first, including itself. */
  landsWith: readonly number[];
}

/**
 * Decide what can merge, and say WHY when something cannot.
 *
 * The distinction that matters: a layer blocked by its own checks is the
 * author's problem, while a layer blocked only because something below it is
 * open is not. Collapsing those two into "not mergeable" is what makes a stack
 * feel like it is fighting you — you fix a layer, nothing changes, and the
 * interface never says the reason is one floor down.
 */
export function evaluateStackMerge(stack: PullRequestStack): LayerMergeVerdict[] {
  validateStack(stack);
  const out: LayerMergeVerdict[] = [];
  let firstBlocker: number | null = null;
  const landed: number[] = [];

  for (const layer of stack.layers) {
    if (layer.merged) {
      out.push({ number: layer.number, mergeable: false, reason: { kind: 'already_merged' }, landsWith: [] });
      continue;
    }
    if (firstBlocker !== null) {
      out.push({
        number: layer.number,
        mergeable: false,
        reason: { kind: 'blocked_below', by: firstBlocker },
        landsWith: [],
      });
      continue;
    }
    if (!layer.ready) {
      firstBlocker = layer.number;
      out.push({ number: layer.number, mergeable: false, reason: { kind: 'own_checks' }, landsWith: [] });
      continue;
    }
    landed.push(layer.number);
    out.push({
      number: layer.number,
      mergeable: true,
      reason: { kind: 'ready' },
      // Merging this layer lands every ready layer beneath it too.
      landsWith: [...landed],
    });
  }
  return out;
}

/** The highest layer that can merge right now, or null when none can. */
export function highestMergeableLayer(stack: PullRequestStack): LayerMergeVerdict | null {
  const verdicts = evaluateStackMerge(stack);
  const mergeable = verdicts.filter((v) => v.mergeable);
  return mergeable.length > 0 ? mergeable[mergeable.length - 1]! : null;
}

/**
 * Which layers a review should actually examine.
 *
 * A layer's diff is against the layer below, so each layer is already scoped to
 * its own change — but a finding raised on a lower layer will still be VISIBLE
 * in the context of every layer above it. Re-reporting it on each layer would
 * multiply one issue into N, and the author would have to dismiss it N times.
 * That is the notification-fatigue failure §1 documents, manufactured by our
 * own tooling.
 *
 * So a finding is attributed to the LOWEST layer it appears in, and suppressed
 * above. Fingerprints come from the review pipeline (P6-3) and are opaque here.
 */
export function attributeFindingsToLayers(input: {
  stack: PullRequestStack;
  /** Fingerprints observed per pull request number. */
  observed: ReadonlyMap<number, readonly string[]>;
}): Map<number, string[]> {
  validateStack(input.stack);
  const attributed = new Map<number, string[]>();
  const claimed = new Set<string>();
  for (const layer of input.stack.layers) {
    const seen = input.observed.get(layer.number) ?? [];
    const fresh = seen.filter((fp) => !claimed.has(fp));
    for (const fp of fresh) claimed.add(fp);
    attributed.set(layer.number, fresh);
  }
  return attributed;
}

/**
 * Advice on whether a change should be a stack at all, and where to cut it.
 *
 * The 200-line figure is GitHub's published finding (PRs under 200 lines review
 * roughly three times faster, with about 40% fewer production defects), which is
 * why it is the threshold rather than a number we invented. It is advice, not a
 * gate: a 900-line change that is one mechanical rename genuinely should not be
 * five PRs, and a tool that insists otherwise gets ignored.
 */
export interface StackAdvice {
  shouldStack: boolean;
  reason: string;
  /** Suggested cut points as (layer label, files) — empty when not stacking. */
  suggestedLayers: ReadonlyArray<{ label: string; files: readonly string[] }>;
}

export const REVIEWABLE_LAYER_LINES = 200;

/*
 * `adviseStacking` was here. A7 claimed it had been deleted; it was still
 * exported, still had a registered control action, and had no caller. It advised
 * splitting a change into a stack — for a stacking system retired earlier in
 * this release, because the build loop emits one squashed patch on one throwaway
 * branch and there was never a second layer to author. Advice with nothing to
 * advise on.
 *
 * `displayRef` and `describeStack` below stay: the brain's PR review renders
 * them (prSecurityReview.ts:1344).
 */


/**
 * Render a branch name as inert display text.
 *
 * Refs come from the forge API, which this pipeline treats as untrusted
 * everywhere else, so it is treated as untrusted here too rather than relying
 * on git's ref-name rules and the host's Markdown sanitizer to save us. Both
 * are someone else's invariants, and this string lands in the bot's
 * high-trust security comment — the one place a spoofed line does the most
 * damage, because it sits directly beside real findings.
 *
 * Control characters are dropped (a newline would let a ref close the fenced
 * block it sits in) and Markdown/HTML metacharacters are neutralised.
 */
export function displayRef(ref: string): string {
  // ASCII controls, then Unicode format characters. The second group matters
  // for the same reason as the first and is easier to miss: bidirectional
  // overrides and isolates (U+202A–202E, U+2066–2069) visually REORDER the
  // text around them, so a ref could make a stack line render as something
  // other than what it says — the Trojan Source class, in the one comment a
  // reader is most inclined to believe. Zero-width and soft-hyphen characters
  // go too, since an invisible character in a branch name is only ever there
  // to make two different refs look identical.
  // eslint-disable-next-line no-control-regex
  const withoutControls = ref.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  const withoutFormatChars = withoutControls.replace(
    /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g,
    '',
  );
  return withoutFormatChars.replace(/[`*_~<>[\]()|\\]/g, '');
}

/** Human-readable stack status for a comment or panel. */
export function describeStack(stack: PullRequestStack): string {
  const verdicts = evaluateStackMerge(stack);
  const lines = stack.layers.map((layer, i) => {
    const verdict = verdicts[i]!;
    const mark = layer.merged ? '✓' : verdict.mergeable ? '●' : '○';
    const note = layer.merged
      ? 'merged'
      : verdict.reason.kind === 'ready'
        ? 'ready'
        : verdict.reason.kind === 'own_checks'
          ? 'not ready'
          : `waiting on #${(verdict.reason as { by: number }).by}`;
    return `${mark} #${layer.number} ${displayRef(layer.head)} — ${note}`;
  });
  return [`Stack on ${displayRef(stack.trunk)} (bottom first):`, ...lines].join('\n');
}
