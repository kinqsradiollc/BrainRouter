/**
 * ADR-028 A8 — the stack panel's view model.
 *
 * Read-only first. Mutation controls appear only for operations that are
 * already reachable with their confirmations, because a button that opens a
 * dialog leading to an error is worse than no button: it costs the user a
 * decision before telling them it was never available.
 *
 * Pure on purpose. Every judgement the panel makes — which layer is blocked,
 * what by, which one may merge, whether an action should be offered at all — is
 * decided here so it can be tested without Electron, and so the panel itself
 * renders rather than reasons.
 */

export interface StackLayerView {
  number: number;
  title: string;
  /** Position from the bottom, 1-based. */
  position: number;
  branch: string;
  merged: boolean;
  checksPassed: boolean;
  checksPending: boolean;
  approved: boolean;
  changesRequested: boolean;
  inMergeQueue: boolean;
  /** True when the branch is behind what it is stacked on. */
  needsSync: boolean;
}

export type LayerReadiness =
  | 'merged'
  | 'ready'
  | 'queued'
  | 'waiting_on_checks'
  | 'waiting_on_review'
  | 'changes_requested'
  | 'needs_sync'
  | 'blocked_below';

export interface LayerStatus {
  readiness: LayerReadiness;
  /** One line naming the blocker. Never "not ready". */
  blocker: string | null;
}

/**
 * Why this layer cannot merge.
 *
 * The order matters: the blocker reported is the one the person can act on
 * FIRST. A layer that is both unapproved and stuck behind an unmerged layer
 * below is reported as blocked below, because getting it approved changes
 * nothing until the one underneath lands.
 */
export function layerStatus(
  layer: StackLayerView,
  layers: readonly StackLayerView[],
): LayerStatus {
  if (layer.merged) return { readiness: 'merged', blocker: null };

  const unmergedBelow = layers.filter((l) => l.position < layer.position && !l.merged);
  if (unmergedBelow.length > 0) {
    const list = unmergedBelow.map((l) => `#${l.number}`).join(', ');
    return {
      readiness: 'blocked_below',
      blocker: `Waiting on ${list} beneath it. Stacks land bottom-up.`,
    };
  }
  if (layer.inMergeQueue) {
    return { readiness: 'queued', blocker: 'In GitHub’s merge queue.' };
  }
  if (layer.changesRequested) {
    return { readiness: 'changes_requested', blocker: 'A review is requesting changes.' };
  }
  if (layer.needsSync) {
    return { readiness: 'needs_sync', blocker: 'Behind the layer below — needs a sync.' };
  }
  if (!layer.checksPassed) {
    return {
      readiness: 'waiting_on_checks',
      blocker: layer.checksPending ? 'Checks are still running.' : 'Checks have not passed.',
    };
  }
  if (!layer.approved) {
    return { readiness: 'waiting_on_review', blocker: 'Not approved yet.' };
  }
  return { readiness: 'ready', blocker: null };
}

/**
 * The highest layer that could merge right now.
 *
 * "Highest" rather than "next" because `gh stack merge` lands everything
 * beneath the target — so the useful answer is how far up the stack a single
 * merge could reach, not merely which one is unblocked.
 */
export function highestMergeable(layers: readonly StackLayerView[]): StackLayerView | null {
  const ordered = [...layers].sort((a, b) => a.position - b.position);
  let best: StackLayerView | null = null;
  for (const layer of ordered) {
    if (layer.merged) continue;
    // Judge each layer on its OWN conditions, not on `layerStatus`, which would
    // report every layer above the bottom as blocked-below and make this always
    // return the bottom one. A cascade merge lands them together, so "blocked
    // by the layer beneath" is not a blocker for a layer we are already
    // including in the same merge.
    if (!ownConditionsMet(layer)) break;
    best = layer;
  }
  return best;
}

/** Ready on its own terms, ignoring what is beneath it. */
function ownConditionsMet(layer: StackLayerView): boolean {
  return (
    !layer.inMergeQueue &&
    !layer.changesRequested &&
    !layer.needsSync &&
    layer.checksPassed &&
    layer.approved
  );
}

/**
 * What the merge button says.
 *
 * Names every pull request that would land, because the operation is
 * all-or-nothing and a button reading "Merge #12" has not told the truth about
 * landing four.
 */
export function mergeButtonLabel(
  target: StackLayerView,
  layers: readonly StackLayerView[],
): string {
  const landing = layers
    .filter((l) => l.position <= target.position && !l.merged)
    .sort((a, b) => a.position - b.position);
  if (landing.length <= 1) return `Merge #${target.number}`;
  return `Merge ${landing.length} layers (${landing.map((l) => `#${l.number}`).join(', ')})`;
}

export interface StackAvailability {
  /** `gh stack` is installed and usable here. */
  capable: boolean;
  /** A halting outcome has latched. */
  halted: boolean;
  reason?: string;
}

export type StackAction = 'view' | 'sync' | 'merge' | 'add' | 'submit';

/**
 * Should this control be shown at all?
 *
 * Hidden rather than disabled when the feature is unavailable: a greyed-out
 * button invites a hover looking for an explanation that a tooltip is a poor
 * place to give. When the extension is missing, the panel says so once, at the
 * top, with the install command.
 *
 * While halted, READ controls stay — you must be able to look at the stack that
 * is stuck, or the panel hides exactly the state needed to fix it.
 */
export function showsAction(action: StackAction, availability: StackAvailability): boolean {
  if (!availability.capable) return false;
  if (availability.halted) return action === 'view';
  return true;
}

/** The one-line banner when the panel cannot offer anything. */
export function unavailableNotice(availability: StackAvailability): string | null {
  if (!availability.capable) {
    return availability.reason ?? 'Stacked pull requests are not available in this repository.';
  }
  if (availability.halted) {
    return (
      `${availability.reason ?? 'A stack operation stopped partway.'} ` +
      'Resolve it in the terminal, then reopen this panel.'
    );
  }
  return null;
}

/**
 * A summary line for the panel header.
 *
 * Counts, not a verdict. "3 of 5 merged" is a fact someone can act on; "stack
 * healthy" is a claim that will eventually be wrong.
 */
export function stackSummary(layers: readonly StackLayerView[]): string {
  if (layers.length === 0) return 'No stack on this branch.';
  const merged = layers.filter((l) => l.merged).length;
  const blocked = layers.filter((l) => {
    const s = layerStatus(l, layers).readiness;
    return s === 'changes_requested' || s === 'waiting_on_checks';
  }).length;
  const parts = [`${merged} of ${layers.length} merged`];
  if (blocked > 0) parts.push(`${blocked} blocked`);
  return parts.join(' · ');
}
