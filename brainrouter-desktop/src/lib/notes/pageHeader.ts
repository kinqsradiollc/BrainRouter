/**
 * ADR-029 E4 — the page header: icon, cover, title, breadcrumbs.
 *
 * Everything the header shows is DERIVED from the same flat list the sidebar
 * and the body read, in one function, because a header that computed its title
 * from one field while the tree computed it from another is how a page ends up
 * called two things on one screen.
 *
 * **The title is not a field this file adds.** B4/E2 already settled it: a
 * page's title IS the page block's `text`, and a separate `title` beside it
 * would be two fields that must agree, merging independently, until the first
 * concurrent edit leaves a heading and a sidebar row that are different
 * sentences. So "editing the title" is `notes-update { text }` on the page
 * block, and this file only says what the field is called on screen.
 *
 * Pure, and takes no workspace root — notes are user-scoped (D1).
 */
import { pageBreadcrumbs, pageLabel, TOP_LEVEL_LABEL } from './pageTree.js';
import type { NoteBlockView } from './notesView.js';

/** One breadcrumb, which is also a destination. */
export interface PageCrumb {
  id: string;
  title: string;
  icon: string | null;
}

export interface PageHeaderView {
  /** Null is the top level — a real page, not "no page". */
  pageId: string | null;
  title: string;
  icon: string | null;
  cover: string | null;
  /** Outermost first, this page last. Empty at the top level. */
  crumbs: PageCrumb[];
  favourite: boolean;
  /** The top level has no block of its own, so there is nothing to rename. */
  editable: boolean;
}

/**
 * What the header renders, for a page or for the top level.
 *
 * The top level is given a header rather than left blank. It holds real content
 * — anything written before a page existed, and anything dragged out of one —
 * and a surface that showed those blocks under no heading at all would look
 * like the page failed to load.
 */
export function pageHeaderView(
  blocks: readonly NoteBlockView[],
  pageId: string | null,
): PageHeaderView {
  const page = pageId === null ? undefined : blocks.find((block) => block.id === pageId);
  if (!page) {
    return {
      pageId: null, title: TOP_LEVEL_LABEL, icon: null, cover: null,
      crumbs: [], favourite: false, editable: false,
    };
  }
  return {
    pageId: page.id,
    title: pageLabel(page),
    icon: page.icon,
    cover: page.cover,
    crumbs: pageBreadcrumbs(blocks, page.id),
    favourite: page.favourite,
    editable: true,
  };
}

/**
 * What the title field shows while it is being edited.
 *
 * `pageLabel` substitutes "Untitled" so a row is never blank and unclickable —
 * but putting that substitution INTO the input means the person has to delete
 * a word nobody typed before they can name their page. The field shows the
 * stored text; the placeholder says what an empty one will be called.
 */
export function titleFieldValue(block: Pick<NoteBlockView, 'text'>): string {
  return block.text;
}

export const PAGE_TITLE_PLACEHOLDER = 'Untitled';

/* -------------------------------------------------------------- icon picker */

/**
 * The glyphs the picker offers.
 *
 * A fixed palette rather than a full emoji keyboard: the picker is a shortcut,
 * and any character can still be pasted into the field. Chosen to cover what
 * people actually label pages with — a kind of document, a state, a subject —
 * rather than to be a representative sample of Unicode.
 */
export const PAGE_ICON_CHOICES: readonly string[] = [
  '📄', '📝', '📓', '📁', '🗂', '📌', '🔖', '📇',
  '✅', '🚧', '🐛', '🔍', '💡', '⚙️', '🧭', '🧪',
  '📊', '📈', '🗓', '⏱', '🔗', '🧩', '🏷', '⭐',
];

/** Whether pressing the icon control adds one or changes one. */
export function iconActionLabel(icon: string | null): string {
  return icon ? 'Change icon' : 'Add icon';
}

export function coverActionLabel(cover: string | null): string {
  return cover ? 'Change cover' : 'Add cover';
}

/**
 * A cover, as the style the header applies, or null when there is none.
 *
 * Null rather than an empty banner: a blank strip above the title looks like an
 * image that failed to load, and the person spends a moment deciding whether
 * the app is broken before concluding the page simply has no cover.
 */
export function coverStyle(cover: string | null): { backgroundImage: string } | null {
  const url = (cover ?? '').trim();
  if (!url) return null;
  // Quoted, because a URL with a space or a paren would otherwise end the
  // `url()` early and silently produce no image at all.
  return { backgroundImage: `url("${url.replace(/"/g, '%22')}")` };
}

/* --------------------------------------------------------------- new pages */

/**
 * Where "add a page" puts the new page, given where it was pressed.
 *
 * Both gestures are one function because they are one decision: the sidebar's
 * top button means the top level, a row's `+` means inside that row, and the
 * header's means inside the page being read. A second helper for "inside"
 * would eventually disagree with this one about what `null` means.
 */
export function newPageIntent(parentId: string | null): { parentId: string | null; title: string } {
  return { parentId, title: '' };
}

/**
 * What the control offers, named by its destination.
 *
 * "New page" everywhere would leave three buttons on one screen that do three
 * different things and say the same word — and the one that reparents is the
 * one worth being sure about before pressing.
 */
export function newPageLabel(parentTitle: string | null): string {
  return parentTitle === null ? 'New page' : `New page inside ${parentTitle}`;
}

export function favouriteActionLabel(favourite: boolean): string {
  return favourite ? 'Remove from favourites' : 'Add to favourites';
}
