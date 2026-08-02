/**
 * ADR-027 D5 (P4-2) — deciding which turns stay rendered.
 *
 * A long session renders every turn it has ever had. The cost is not the
 * scrollback itself but everything hanging off it: syntax-highlighted diffs,
 * tool-result tables, images, each an independent subtree the renderer keeps
 * live. Sessions get slower the longer they are useful, which is exactly
 * backwards.
 *
 * Folding collapses old turns to a one-line summary that expands on demand. The
 * question this module answers is only WHICH — the rendering is the desktop's.
 *
 * The rule that makes it safe is that folding must never lose the thread of the
 * conversation. Three things therefore survive regardless of age:
 *
 *   - The most recent turns, because that is what is being read.
 *   - Anything explicitly pinned, because the user said so.
 *   - Anything a surviving turn REFERENCES, because a visible reply citing a
 *     folded question reads as a non-sequitur — and the reader cannot tell
 *     whether they missed something or the agent lost the plot.
 *
 * That last rule is the one a naive "keep the last N" implementation gets
 * wrong, and it is invisible in testing because short sessions never trip it.
 */

export interface FoldableTurn {
  id: string;
  /** Rough render cost. Any consistent unit; the desktop uses node count. */
  weight: number;
  /** User-pinned turns are never folded. */
  pinned?: boolean;
  /** Ids of earlier turns this one refers to. */
  references?: readonly string[];
}

export interface FoldPlan {
  /** Turn ids to render in full, oldest first. */
  expanded: readonly string[];
  /** Turn ids to collapse to a summary line. */
  folded: readonly string[];
  /** Total weight of the expanded set. */
  renderedWeight: number;
  /** Weight removed from the render tree. */
  foldedWeight: number;
}

export interface FoldOptions {
  /**
   * Render-weight ceiling. Folding stops once the expanded set fits, so a
   * session of small turns folds nothing and one with a single huge turn is
   * not punished for the turns around it.
   */
  maxWeight: number;
  /**
   * Most recent turns always kept whole, regardless of weight. Without this a
   * single enormous latest turn would fold itself, which is the one turn the
   * user is certainly looking at.
   */
  keepRecent?: number;
}

/**
 * Decide which turns to fold.
 *
 * `turns` must be in conversation order, oldest first.
 *
 * Folding proceeds oldest-first and stops as soon as the remainder fits: the
 * cheapest correct answer, and it keeps the plan stable as a session grows —
 * one new turn should not reshuffle what is already folded, because a
 * scrollback that rearranges itself while being read is worse than a slow one.
 */
export function planFolding(
  turns: readonly FoldableTurn[],
  options: FoldOptions,
): FoldPlan {
  const keepRecent = Math.max(0, options.keepRecent ?? 3);
  const total = turns.reduce((sum, turn) => sum + turn.weight, 0);

  const protectedIds = new Set<string>();
  for (const turn of turns.slice(Math.max(0, turns.length - keepRecent))) protectedIds.add(turn.id);
  for (const turn of turns) if (turn.pinned) protectedIds.add(turn.id);

  // Fold oldest-first only while over budget.
  const foldedIds = new Set<string>();
  let weight = total;
  for (const turn of turns) {
    if (weight <= options.maxWeight) break;
    if (protectedIds.has(turn.id)) continue;
    foldedIds.add(turn.id);
    weight -= turn.weight;
  }

  // Rescue anything a SURVIVING turn references. Repeated to a fixed point:
  // rescuing a turn can surface its own references, and stopping after one
  // round would leave a rescued turn citing something still folded.
  for (;;) {
    let rescued = false;
    for (const turn of turns) {
      if (foldedIds.has(turn.id)) continue;
      for (const reference of turn.references ?? []) {
        if (foldedIds.delete(reference)) rescued = true;
      }
    }
    if (!rescued) break;
  }

  const expanded = turns.filter((turn) => !foldedIds.has(turn.id));
  const folded = turns.filter((turn) => foldedIds.has(turn.id));
  return {
    expanded: expanded.map((turn) => turn.id),
    folded: folded.map((turn) => turn.id),
    renderedWeight: expanded.reduce((sum, turn) => sum + turn.weight, 0),
    foldedWeight: folded.reduce((sum, turn) => sum + turn.weight, 0),
  };
}

/**
 * Describe a fold plan.
 *
 * Returns null when nothing folded — a banner saying "0 turns hidden" is noise
 * that trains people to ignore the banner that matters.
 */
export function describeFolding(plan: FoldPlan): string | null {
  if (plan.folded.length === 0) return null;
  return `${plan.folded.length} earlier turn(s) collapsed to keep this session responsive. Select one to expand it.`;
}
