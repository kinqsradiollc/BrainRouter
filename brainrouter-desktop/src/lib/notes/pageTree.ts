/**
 * ADR-029 B4 + E4 — the sidebar's page tree, and what a drag inside it means.
 *
 * B4 says a page is a block with children, so there is no page table to read:
 * the tree is the same recursion over `parentId` the document already is,
 * filtered to the blocks whose kind is `page`. Everything here is a projection
 * over the flat list `notes-read` already returns, which is why none of it
 * fetches anything.
 *
 * **The one judgement worth naming is what "inside" means.** A sub-page created
 * inside a toggle on page A has that toggle as its literal parent, and a
 * sidebar that nested it under the toggle would show a tree the document does
 * not have — the person put it on page A. So the tree nests by NEAREST PAGE
 * ANCESTOR rather than by `parentId`, and the same function decides which
 * blocks a page's body renders. Two answers to "which page is this on" is how
 * the sidebar and the editor end up disagreeing about where something lives.
 *
 * Pure, and takes no workspace root: notes are user-scoped (D1), and a function
 * here that needed one would mean the scoping had regressed.
 */
// The editing barrel is core's browser-safe half — the `notes` barrel reaches
// the filesystem, this one is pure by construction — so a constant a person
// reads on screen comes from the same place the store's own default does. A
// second `'Untitled'` spelled here is how one surface starts calling a page
// something the other does not.
import { UNTITLED_PAGE } from '@kinqs/brainrouter-core/notes/editing';
import type { NoteBlockView } from './notesView.js';

/**
 * What the top level is called, everywhere it has to be named.
 *
 * The tree's root is a real place — a block created before any page exists
 * lives there — so it needs a name in the sidebar, in the breadcrumbs and
 * beside a search result. One spelling, because two would let the same
 * destination look like two different ones on the same screen.
 */
export const TOP_LEVEL_LABEL = 'Top level';

/** What the sidebar renders one row from. */
export interface PageTreeNode {
  id: string;
  title: string;
  /** The page's glyph, or null when it has none — never a placeholder. */
  icon: string | null;
  favourite: boolean;
  children: PageTreeNode[];
}

/** A row of the flattened, expand-aware tree. */
export interface PageTreeRow {
  node: PageTreeNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * A page's label.
 *
 * `title` is the host's rendering of the page block's own `text` field (B4/E4 —
 * the title IS that field, there is no second one), so this prefers it and
 * falls back for any surface that does not send it rather than rendering the
 * empty string.
 */
export function pageLabel(block: Pick<NoteBlockView, 'title' | 'text'>): string {
  return (block.title ?? '').trim() || block.text.trim() || UNTITLED_PAGE;
}

/**
 * Every block's nearest ancestor of kind `page`, or null for the top level.
 *
 * Built once per call and shared by the tree, the breadcrumbs and the page
 * body, because three walks that each decide "which page is this on" would
 * eventually decide it differently.
 *
 * The walk is cycle-guarded even though the host's list arrives already
 * repaired by `buildNoteTree`: the browser dev harness serves its own list, and
 * a loop there would hang the renderer rather than showing a wrong tree.
 */
export function pageParents(blocks: readonly NoteBlockView[]): Map<string, string | null> {
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const out = new Map<string, string | null>();

  for (const block of blocks) {
    const seen = new Set<string>([block.id]);
    let cursor = block.parentId;
    let found: string | null = null;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = byId.get(cursor);
      if (!parent) break;
      if (parent.kind === 'page') { found = parent.id; break; }
      cursor = parent.parentId;
    }
    out.set(block.id, found);
  }
  return out;
}

/**
 * The page tree, in document order.
 *
 * Order is NOT recomputed here: the flat list arrives ranked by core, and a
 * second sort in the renderer would put the sidebar in a different order from
 * the page it mirrors.
 */
export function buildPageTree(blocks: readonly NoteBlockView[]): PageTreeNode[] {
  const parents = pageParents(blocks);
  const nodes = new Map<string, PageTreeNode>();
  const roots: PageTreeNode[] = [];

  for (const block of blocks) {
    if (block.kind !== 'page') continue;
    nodes.set(block.id, {
      id: block.id,
      title: pageLabel(block),
      icon: block.icon,
      favourite: block.favourite,
      children: [],
    });
  }
  for (const block of blocks) {
    if (block.kind !== 'page') continue;
    const node = nodes.get(block.id)!;
    const parent = parents.get(block.id) ?? null;
    const parentNode = parent === null ? null : nodes.get(parent);
    if (parentNode) parentNode.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** The tree flattened to the rows currently on screen. */
export function pageTreeRows(
  nodes: readonly PageTreeNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
): PageTreeRow[] {
  const rows: PageTreeRow[] = [];
  for (const node of nodes) {
    const isOpen = expanded.has(node.id);
    rows.push({ node, depth, hasChildren: node.children.length > 0, expanded: isOpen });
    if (isOpen) rows.push(...pageTreeRows(node.children, expanded, depth + 1));
  }
  return rows;
}

/** The chain of pages down to this one, outermost first, the page itself last. */
export function pageBreadcrumbs(
  blocks: readonly NoteBlockView[],
  pageId: string | null,
): Array<{ id: string; title: string; icon: string | null }> {
  if (pageId === null) return [];
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const parents = pageParents(blocks);

  const chain: Array<{ id: string; title: string; icon: string | null }> = [];
  const seen = new Set<string>();
  let cursor: string | null = pageId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const block = byId.get(cursor);
    if (!block) break;
    chain.unshift({ id: block.id, title: pageLabel(block), icon: block.icon });
    cursor = parents.get(cursor) ?? null;
  }
  return chain;
}

/**
 * The blocks a page's body renders.
 *
 * A sub-page appears here as ONE row rather than as its contents — its own
 * blocks belong to it, not to this page. Rendering the subtree inline would put
 * the whole workspace on every page, and there would be no gesture that opens a
 * sub-page because it would already be open.
 *
 * `null` is the top level, and it is a real page rather than an empty state: a
 * block created before any page exists lives there, and a body that rendered
 * nothing for it would be content present in the data and absent from the
 * screen — A3's quietly-wrong shape.
 */
export function blocksOnPage(
  blocks: readonly NoteBlockView[],
  pageId: string | null,
): NoteBlockView[] {
  const parents = pageParents(blocks);
  return blocks.filter((block) => block.id !== pageId && (parents.get(block.id) ?? null) === pageId);
}

/**
 * A page's body with depth measured FROM the page, not from the document root.
 *
 * `depth` arrives absolute, because the host walks the whole tree once. On the
 * top level the two agree, so the flat list looked right and this was easy to
 * miss — but open a page three levels down and every line on it starts three
 * indents in, with the text squeezed against the right edge for a nesting the
 * reader cannot see the top of. The page IS the root while you are on it.
 *
 * Clamped at zero rather than trusted: a block whose depth disagrees with its
 * page ancestry is possible while a repair is in flight, and a negative indent
 * would pull the line outside the column.
 */
export function pageBodyBlocks(
  blocks: readonly NoteBlockView[],
  pageId: string | null,
): NoteBlockView[] {
  const page = pageId === null ? null : blocks.find((block) => block.id === pageId);
  // The top level has no block of its own, so its children are already at zero.
  const base = page ? page.depth : -1;
  return blocksOnPage(blocks, pageId).map((block) => ({
    ...block,
    depth: Math.max(0, block.depth - base - 1),
  }));
}

/**
 * The page to actually show, given what was selected.
 *
 * A selected page can vanish — deleted on this device, or a tombstone arriving
 * from another one — and a shell that kept the id would render a page header
 * for something that is not there. Falling back to the top level shows a
 * surface that is still true.
 */
export function selectedPageOrTop(
  blocks: readonly NoteBlockView[],
  selectedId: string | null,
): string | null {
  if (selectedId === null) return null;
  const block = blocks.find((candidate) => candidate.id === selectedId);
  return block && block.kind === 'page' ? block.id : null;
}

/** Expanding down to a page, so opening it from anywhere reveals it in the tree. */
export function withAncestorsExpanded(
  blocks: readonly NoteBlockView[],
  pageId: string | null,
  expanded: ReadonlySet<string>,
): Set<string> {
  const next = new Set(expanded);
  for (const crumb of pageBreadcrumbs(blocks, pageId)) next.add(crumb.id);
  return next;
}

/* ------------------------------------------------------------ drag and drop */

export type PageDropPosition = 'before' | 'after' | 'inside';

/** What a completed drag asks the store to do — `notes-move`'s arguments. */
export interface PageMoveIntent {
  id: string;
  parentId: string | null;
  before?: string;
  after?: string;
}

/** Is `candidateId` inside `ancestorId`, at any depth? */
export function isDescendantPage(
  blocks: readonly NoteBlockView[],
  ancestorId: string,
  candidateId: string,
): boolean {
  const parents = pageParents(blocks);
  const seen = new Set<string>();
  let cursor: string | null = parents.get(candidateId) ?? null;
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === ancestorId) return true;
    seen.add(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  return false;
}

/**
 * What this drop means, or null when it means nothing.
 *
 * **Dropping a page into its own subtree is refused here rather than repaired
 * later.** `parentId` merges last-writer-wins, so the store would accept it and
 * `buildNoteTree` would break the resulting cycle by detaching a member — which
 * the person sees as the page they dragged jumping to the top level on its own.
 * A gesture that cannot mean anything should do nothing, visibly, at the moment
 * it is made.
 */
export function pageDropIntent(
  blocks: readonly NoteBlockView[],
  dragId: string,
  targetId: string | null,
  position: PageDropPosition,
): PageMoveIntent | null {
  if (dragId === targetId) return null;
  if (targetId !== null && isDescendantPage(blocks, dragId, targetId)) return null;

  // The top level as a target: dropped onto the tree's background, not a row.
  if (targetId === null) return { id: dragId, parentId: null };

  if (position === 'inside') return { id: dragId, parentId: targetId };

  const parents = pageParents(blocks);
  const parentId = parents.get(targetId) ?? null;
  return position === 'before'
    ? { id: dragId, parentId, before: targetId }
    : { id: dragId, parentId, after: targetId };
}

/**
 * Where a drop lands within a row, from the pointer's position in it.
 *
 * The top and bottom eighths reorder, and the whole middle reparents. Notion's
 * proportions, and for a reason worth keeping: reordering is the gesture people
 * repeat, but nesting is the one they mean deliberately, so the ambiguous
 * middle belongs to the deliberate move rather than to the frequent one.
 */
export function dropPositionInRow(offsetY: number, height: number): PageDropPosition {
  if (height <= 0) return 'inside';
  const ratio = offsetY / height;
  if (ratio <= 0.25) return 'before';
  if (ratio >= 0.75) return 'after';
  return 'inside';
}
