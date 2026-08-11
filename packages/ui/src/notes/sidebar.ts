/**
 * ADR-029 E4 — the sidebar's two other sections, favourites and trash.
 *
 * Both arrive already computed: the host answers `notes-favourites` and
 * `notes-trash` from core's projections over the block store, so neither is a
 * list this file assembles. What is decided HERE is what an entry is called,
 * what an empty section says, and what a restore promises — the sentences a
 * person reads, which is exactly the part that would otherwise live inside a
 * component and be untestable.
 *
 * **The trash's line comes from core.** `describeTrashEntry` already knows that
 * restoring a page brings its contents back with it, and says so; re-deriving
 * that sentence from `descendants` here would give the desktop one count and
 * any other surface another the first time the rule changed.
 */

/** A favourite, exactly as `notes-favourites` answers. */
export interface FavouriteRow {
  id: string;
  kind: string;
  title: string;
  icon: string | null;
}

/** A trash entry as `notes-trash` answers, with core's rendered line. */
export interface TrashEntryDto {
  id: string;
  kind: string;
  title: string;
  descendants: number;
  /** Core's `describeTrashEntry` — what comes back, not just what went. */
  line?: string;
}

export interface TrashRow {
  id: string;
  /** What the row says. Falls back to the title so a row is never blank. */
  line: string;
  isPage: boolean;
  /** How many blocks come back with it — shown as a caution, not as a count. */
  descendants: number;
}

export function trashRows(entries: readonly TrashEntryDto[]): TrashRow[] {
  return entries.map((entry) => ({
    id: entry.id,
    // A newer host sends the line; an older one, or the browser harness, may
    // not. Rendering the bare title is worse than the sentence and better than
    // an empty row — and it is a fallback, not a second implementation.
    line: (entry.line ?? '').trim() || entry.title.trim() || 'Untitled',
    isPage: entry.kind === 'page',
    descendants: entry.descendants,
  }));
}

/**
 * What a restore is about to do, said before it is pressed.
 *
 * C5 restores the subtree, which is the right behaviour and a surprising one:
 * pressing restore on a page brings back everything that was inside it,
 * including things the person deleted deliberately an hour earlier. Saying so
 * costs a line and removes the surprise.
 */
export function restorePromise(row: TrashRow): string {
  if (row.descendants === 0) return 'Put it back where it was.';
  return `Put it back, with the ${row.descendants} block${row.descendants === 1 ? '' : 's'} inside it.`;
}

/* ------------------------------------------------------------ empty states */

/**
 * Empty sections say what would fill them, not "nothing here".
 *
 * A person looking at an empty favourites list is deciding whether the feature
 * is broken or unused, and "No favourites" answers neither question.
 */
export const SIDEBAR_EMPTY = {
  pages: 'No pages yet. Add one and it appears here.',
  favourites: 'Pin a page here to keep it at the top.',
  trash: 'Nothing deleted. Deleted pages wait here rather than going away.',
} as const;

export type SidebarSection = keyof typeof SIDEBAR_EMPTY;

/** The sidebar's section headings, in the order they are shown. */
export const SIDEBAR_SECTIONS: ReadonlyArray<{ id: SidebarSection; label: string }> = [
  { id: 'favourites', label: 'Favourites' },
  { id: 'pages', label: 'Pages' },
  { id: 'trash', label: 'Trash' },
];

/**
 * Which sections are worth opening on first render.
 *
 * Pages always; favourites only when there are some. A section that opens onto
 * its own empty state every time teaches people to collapse it, and then they
 * stop seeing it when it does have something in it. Trash stays shut: it is
 * where you go deliberately.
 */
export function initialOpenSections(favouriteCount: number): Set<SidebarSection> {
  const open = new Set<SidebarSection>(['pages']);
  if (favouriteCount > 0) open.add('favourites');
  return open;
}
