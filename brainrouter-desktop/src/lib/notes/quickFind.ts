/**
 * ADR-029 E4 + B5 — quick find, as a projection over core's ranked search.
 *
 * **Nothing here scores anything.** The hits arrive from `notes-search`, which
 * is core's `searchNotes`: prose above link-only, earlier above later, an id
 * like `BR-114` matched as well as the whole URI. A second ranking in the
 * renderer would put the same query in a different order on the desktop than in
 * the dashboard, and the person seeing both would be right to conclude one of
 * them is broken. This file turns hits into ROWS — what each one is called,
 * which page it is on, and where selecting it lands — and preserves the order
 * it was given.
 *
 * The keyboard model lives here too, because "does the selection wrap at the
 * end" is a decision, not markup, and a decision in a keydown handler is one
 * nobody can test.
 */
import { blocksOnPage, pageBreadcrumbs, pageLabel, pageParents, TOP_LEVEL_LABEL } from './pageTree.js';
import type { NoteBlockView } from './notesView.js';

/** One hit as `notes-search` returns it — core's `NoteSearchHit`, over the wire. */
export interface QuickFindHit {
  blockId: string;
  kind: string;
  /** Which halves matched: `text`, `reference`, or both. Never empty. */
  matched: readonly string[];
  snippet: string;
  matchedRefs: readonly string[];
  score: number;
}

export interface QuickFindRow {
  blockId: string;
  /** The page selecting this row opens. Null is the top level, not "nowhere". */
  pageId: string | null;
  /** What the row is called: a page's title, or the matching line. */
  label: string;
  /** Where it lives, so two identical lines on two pages stay distinguishable. */
  context: string;
  kind: string;
  isPage: boolean;
  /** B5 — a link-only match is a different answer from a prose one. */
  matchedOn: 'text' | 'reference' | 'both';
}

// The top level's name belongs to the tree, which is the thing that has a root.
// Re-exported rather than respelled so a caller reaching for it here gets the
// same string the sidebar and the breadcrumbs use.
export { TOP_LEVEL_LABEL };

/**
 * Hits, as rows.
 *
 * A hit whose block is no longer in the loaded list is DROPPED rather than
 * rendered: the search ran against the host's store, and a block deleted
 * between that answer and this render would give a row that opens nothing. An
 * entry that does nothing when pressed is worse than one that is not offered.
 */
export function quickFindRows(
  hits: readonly QuickFindHit[],
  blocks: readonly NoteBlockView[],
): QuickFindRow[] {
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const parents = pageParents(blocks);
  const rows: QuickFindRow[] = [];

  for (const hit of hits) {
    const block = byId.get(hit.blockId);
    if (!block) continue;

    const isPage = block.kind === 'page';
    // A page's row opens the page itself; any other block's row opens the page
    // it is on, because that is where it can actually be read.
    const pageId = isPage ? block.id : parents.get(block.id) ?? null;
    const trail = pageBreadcrumbs(blocks, isPage ? parents.get(block.id) ?? null : pageId);

    rows.push({
      blockId: block.id,
      pageId,
      label: isPage ? pageLabel(block) : hit.snippet.trim() || block.text.trim() || '(empty line)',
      context: trail.length > 0 ? trail.map((crumb) => crumb.title).join(' / ') : TOP_LEVEL_LABEL,
      kind: block.kind,
      isPage,
      matchedOn: matchedOn(hit.matched),
    });
  }
  return rows;
}

function matchedOn(matched: readonly string[]): QuickFindRow['matchedOn'] {
  const text = matched.includes('text');
  const reference = matched.includes('reference');
  if (text && reference) return 'both';
  return reference ? 'reference' : 'text';
}

/**
 * The note beside a row that matched on a LINK rather than on what it says.
 *
 * B5 keeps the two halves apart on the grounds that reporting a
 * machine-generated identifier as though the person had written the word makes
 * a search stop being trusted. The same holds one layer up: a row that matched
 * only a reference has to say so, or it looks like a result for a word that is
 * not in it.
 */
export function quickFindMatchNote(row: QuickFindRow): string | null {
  return row.matchedOn === 'reference' ? 'links to it' : null;
}

/** Move the highlight, wrapping — an empty list has nothing to select. */
export function moveQuickFindSelection(count: number, current: number, delta: number): number {
  if (count <= 0) return 0;
  return ((current + delta) % count + count) % count;
}

/** Is this the ⌘K / Ctrl-K gesture? */
export function isQuickFindShortcut(event: {
  key: string; metaKey: boolean; ctrlKey: boolean;
}): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
}

/**
 * What quick find offers before anything is typed.
 *
 * The pages, most recently written first — not an empty panel. ⌘K with nothing
 * in it is how people navigate when they know the page's name and cannot
 * remember a word from inside it, and an empty box makes them type first to
 * find out whether the feature works at all.
 *
 * Recency is approximated by document order reversed rather than by a stored
 * timestamp: a page's blocks carry stamps, but "when was this page last
 * touched" is not a field, and inventing one here would be a value nobody wrote
 * that two devices could disagree about.
 */
export function quickFindDefaultRows(blocks: readonly NoteBlockView[], limit = 12): QuickFindRow[] {
  const parents = pageParents(blocks);
  const rows: QuickFindRow[] = [];
  for (const block of blocks) {
    if (block.kind !== 'page') continue;
    const trail = pageBreadcrumbs(blocks, parents.get(block.id) ?? null);
    rows.push({
      blockId: block.id,
      pageId: block.id,
      label: pageLabel(block),
      context: trail.length > 0 ? trail.map((crumb) => crumb.title).join(' / ') : TOP_LEVEL_LABEL,
      kind: 'page',
      isPage: true,
      matchedOn: 'text',
    });
  }
  return rows.slice(0, limit);
}

/**
 * What the panel says when a query found nothing.
 *
 * It names the two halves that were searched, because "no results" for a query
 * that only ever looked at prose would be a lie about a note that links to the
 * thing being asked for.
 */
export function quickFindEmptyNote(query: string): string {
  return query.trim().length === 0
    ? 'Type to search every page and every line, including what they link to.'
    : 'Nothing here says that, and nothing links to it.';
}

/**
 * How many blocks the page a row lands on holds — the count shown beside it.
 *
 * Q3's shape, one layer up: a count rather than the contents. The panel is a
 * way to get somewhere, and putting the page's blocks in it would make the
 * search results a second document to read.
 */
export function pageSizeNote(blocks: readonly NoteBlockView[], pageId: string | null): string {
  const count = blocksOnPage(blocks, pageId).length;
  return count === 1 ? '1 block' : `${count} blocks`;
}
