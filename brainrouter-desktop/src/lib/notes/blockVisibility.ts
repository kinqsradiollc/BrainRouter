/**
 * ADR-029 F3 — which blocks a page DRAWS, and why the ones it does not are still there.
 *
 * Two separate reasons a block on a page is not a row in its body, kept in one
 * file because a page composes both and a second module would eventually let one
 * of them decide the other was already handled.
 *
 * **A collapsed toggle folds its children away.** That is a DISPLAY state and
 * nothing else. The blocks are still in the list this function was given, still
 * in the store, still in core's search index, and still resolvable by a
 * reference that points into them — a note that "loses" text because a parent
 * was folded is the worst bug a notes app can have, and the way that bug gets
 * written is by making collapse a filter somewhere upstream of the renderer
 * instead of a fold inside it. So `collapsedHiddenIds` takes the whole body and
 * returns ids; it never returns a shorter list of blocks, because a caller
 * handed a shorter list has no way to notice what went missing.
 *
 * **A search overrides the fold.** If a query matched a block inside a collapsed
 * toggle, that block is shown. Otherwise typing a word that IS on the page
 * reports the page as having nothing in it — which is the same lie as losing the
 * text, arriving through the search box instead.
 *
 * **A table's rows are drawn by the table.** A `table-row`'s nearest container
 * ancestor is the page (a table is not a container in the sidebar's sense), so
 * without this every row would appear twice: once inside the grid and once as a
 * loose line beside it. Same argument E3 already made for a database's rows.
 */
import type { NoteBlockView } from './notesView.js';

/** Map of id → parent id, over exactly the blocks given. */
function parentsWithin(blocks: readonly NoteBlockView[]): Map<string, string | null> {
  const present = new Set(blocks.map((block) => block.id));
  return new Map(blocks.map((block) => [
    block.id,
    block.parentId && present.has(block.parentId) ? block.parentId : null,
  ] as const));
}

/**
 * The ids a collapsed toggle is currently folding away.
 *
 * `matchIds` is the in-page search's hits, or null when nothing was typed. A hit
 * is never folded — see the header for why that is not a special case but the
 * whole rule.
 */
export function collapsedHiddenIds(
  blocks: readonly NoteBlockView[],
  matchIds: ReadonlySet<string> | null = null,
): Set<string> {
  const parents = parentsWithin(blocks);
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const hidden = new Set<string>();

  for (const block of blocks) {
    if (matchIds !== null && matchIds.has(block.id)) continue;
    // Walk up rather than down: the answer is "is any ancestor a folded
    // toggle", and the chain is short while the subtree can be a whole page.
    const seen = new Set<string>([block.id]);
    let cursor = parents.get(block.id) ?? null;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = byId.get(cursor);
      if (!parent) break;
      if (parent.kind === 'toggle' && parent.collapsed) { hidden.add(block.id); break; }
      cursor = parents.get(cursor) ?? null;
    }
  }
  return hidden;
}

/**
 * The ids some OTHER block already draws — today, a table's rows.
 *
 * Transitive, because a row can hold nested blocks and those belong to the cell
 * rather than to the page.
 */
export function tableOwnedIds(blocks: readonly NoteBlockView[]): Set<string> {
  return new Set(tableOwners(blocks).keys());
}

/**
 * Every block to the table that DRAWS it, when one does.
 *
 * Built once and read twice: once to drop the rows a table already renders, and
 * once to answer the search's awkward case. A query that matched a cell has
 * matched a `table-row`, whose text is an encoded line of cells — rendering that
 * raw would show `Parser|Ana|Friday` as a paragraph, and dropping it would
 * report a page as having nothing that matches a word plainly on it. Showing the
 * TABLE is the only answer that is neither.
 */
function tableOwners(blocks: readonly NoteBlockView[]): Map<string, string> {
  const parents = parentsWithin(blocks);
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const owners = new Map<string, string>();

  for (const block of blocks) {
    const seen = new Set<string>([block.id]);
    let cursor = parents.get(block.id) ?? null;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = byId.get(cursor);
      if (!parent) break;
      if (parent.kind === 'table') { owners.set(block.id, parent.id); break; }
      cursor = parents.get(cursor) ?? null;
    }
  }
  return owners;
}

/**
 * A page's body, as rows — the fold, the table and the search, in one pass.
 *
 * One function so a caller cannot apply the fold and forget the table, which
 * would put every table row on screen twice the moment somebody collapsed
 * something; and so the search's interaction with both is decided once.
 *
 * `matchIds` is the in-page search's hits, or null when nothing was typed. Null
 * is NOT the same as an empty set: no query shows everything, a query with no
 * hits shows nothing.
 */
export function bodyRows(
  blocks: readonly NoteBlockView[],
  matchIds: ReadonlySet<string> | null = null,
): NoteBlockView[] {
  const hidden = collapsedHiddenIds(blocks, matchIds);
  const owners = tableOwners(blocks);

  // A hit that is drawn by something else promotes its drawer, so a word typed
  // into a table cell finds the table it is in.
  let keep: Set<string> | null = null;
  if (matchIds !== null) {
    keep = new Set<string>(matchIds);
    for (const id of matchIds) {
      const drawer = owners.get(id);
      if (drawer) keep.add(drawer);
    }
  }

  return blocks.filter((block) => (
    !hidden.has(block.id)
    && !owners.has(block.id)
    && (keep === null || keep.has(block.id))
  ));
}

/** How many children a fold is hiding, so the twisty can say so rather than imply it. */
export function collapsedCount(blocks: readonly NoteBlockView[], toggleId: string): number {
  const parents = parentsWithin(blocks);
  let count = 0;
  for (const block of blocks) {
    const seen = new Set<string>([block.id]);
    let cursor = parents.get(block.id) ?? null;
    while (cursor !== null && !seen.has(cursor)) {
      if (cursor === toggleId) { count += 1; break; }
      seen.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
  }
  return count;
}

/**
 * What the twisty says it will do.
 *
 * A fold with nothing under it is not an error — a toggle someone just made has
 * no children yet — but it should not claim to hide anything, or the person
 * presses it, sees no change, and concludes the control is broken.
 */
export function toggleActionLabel(collapsed: boolean, childCount: number): string {
  if (childCount === 0) return 'Nothing inside yet — indent a line under this one';
  if (collapsed) return childCount === 1 ? 'Show 1 line inside' : `Show ${childCount} lines inside`;
  return 'Hide what is inside';
}
