/**
 * ADR-029 Part B — the Notes mode's view model.
 *
 * Pure, for the same reason the planner's is: every judgement about what is
 * editable, what a block's placeholder says, which cross-mode moves a line
 * offers and how a conflict reads is testable without Electron, and the
 * component stays markup.
 *
 * Notes are USER-scoped (D1), so nothing here takes a workspace root. If a
 * function in this file ever needs one, the scoping has regressed the way
 * ADR-028 D9 recorded for the planner.
 */
import type { NoteCommentDto } from './commentThread.js';

export interface NoteBlockView {
  id: string;
  parentId: string | null;
  depth: number;
  kind: string;
  text: string;
  checked: boolean;
  level: number | null;
  hasChildren: boolean;
  /**
   * F3 — a toggle's children are folded away.
   *
   * The block's OWN stamped field (`NoteBlock.collapsed`), not a set the shell
   * keeps: a fold is a decision about the document that should still be folded
   * when you come back to it, and on the other device too. It merges
   * last-writer-wins with no marker, which `blockMerge.ts` argues for directly —
   * a conflict banner over a folded toggle teaches people to dismiss the banner
   * that matters.
   */
  collapsed: boolean;
  /**
   * B4/E4 — a container's title, which is the block's OWN `text` rendered by
   * the host through core's `pageTitleOrDefault`.
   *
   * A page has one, and E3's database has one — it is the heading over its rows
   * and the name the sidebar and the breadcrumbs call it. Null for every other
   * kind rather than the same string: "Untitled" on an empty paragraph reads as
   * a name someone gave it, not as an absence.
   */
  title: string | null;
  /** The glyph in front — a page's icon, a callout's emoji. Never a placeholder. */
  icon: string | null;
  /** A page's cover image, as a URL or an attachment reference (D3). */
  cover: string | null;
  /** Pinned into the sidebar's favourites. */
  favourite: boolean;
  /**
   * F3 — this page is a template: something to start from, not something to
   * read. A page, per B4 — the flag is the whole difference.
   */
  template: boolean;
  /**
   * F3 — the comments on this block, flattened out of core's stamped records.
   *
   * Present on every block rather than fetched per block, because the marker
   * beside a line has to be there before anyone clicks it: a badge that appears
   * only after a round trip is one nobody knows to look for.
   */
  comments: NoteCommentDto[];
  /**
   * E4 — a numbered item's number, computed by core from tree position.
   *
   * Optional because it only exists for `numbered`, and because a surface that
   * counted the rendered rows itself would number a filtered page 1, 2, 3 while
   * the document said 4, 7, 9.
   */
  ordinal?: number | null;
  /** References this block currently makes, canonically spelled (A2). */
  refs: string[];
  /** Fields whose merge could not be decided — the human picks (D4). */
  conflicts: NoteConflictView[];
  /** B2's attribution when another device holds the lease, else null. */
  lockedBy: string | null;
}

/**
 * A kept-both field, and WHY it was kept.
 *
 * The reason travels as a plain string rather than core's union because the
 * renderer must not pull the notes barrel into a browser bundle — it reaches
 * the filesystem. The cost is that an unrecognised reason has to render
 * something honest instead of failing to compile, which `conflictLine` does.
 */
export interface NoteConflictView {
  field: string;
  reason: string;
  /** Exact kept-both versions rendered to the person; required to reject stale clicks. */
  oursAt: NoteConflictClockView;
  theirsAt: NoteConflictClockView;
}

/** Browser-safe spelling of core's HLC; the shared renderer must not import sync internals. */
export interface NoteConflictClockView {
  physical: number;
  logical: number;
  deviceId: string;
}

export interface NoteConflictExpectedView {
  oursAt: NoteConflictClockView;
  theirsAt: NoteConflictClockView;
}

export interface NoteTreeRepairView {
  blockId: string;
  reason: 'cycle' | 'missing_parent' | 'deleted_parent';
  claimedParentId: string;
}

/**
 * Indentation, capped.
 *
 * B4 makes nesting unbounded — a page is a block with children, all the way
 * down — but a screen is not. Past this depth further nesting stops adding
 * information and starts removing width from the text, so the visual depth
 * saturates while the real one keeps working.
 */
export const MAX_VISUAL_DEPTH = 8;

export function indentFor(depth: number): number {
  return Math.min(depth, MAX_VISUAL_DEPTH) * 18;
}

/** What an empty block invites, per kind. Never "type something". */
export function placeholderFor(kind: string): string {
  switch (kind) {
    case 'page': return 'Untitled page';
    case 'heading': return 'Section';
    case 'todo': return 'Something to do';
    case 'code': return 'Code';
    case 'quote': return 'Quoted';
    case 'embed': return 'Paste a brainrouter:// reference';
    // F3 — the kinds that used to render as a plain line now have a shape, so
    // their empty state invites the thing that shape is for.
    case 'toggle': return 'What this hides — indent the detail under it';
    case 'callout': return 'The thing that should not be skimmed past';
    case 'bookmark': return 'Paste a web address';
    case 'synced': return 'Pick a block to show here';
    case 'table-row': return '';
    default: return 'Write, or paste a link to anything in the workspace';
  }
}

/**
 * F3 — a callout's glyph when nobody has chosen one.
 *
 * A callout with no icon is a bordered paragraph, which is not what the person
 * picked from the menu. The default is a fallback for RENDERING only: it is
 * never written to the block, so choosing one later is the first edit to the
 * field and there is nothing stored to merge against.
 */
export const DEFAULT_CALLOUT_ICON = '💡';

export function calloutIcon(icon: string | null): string {
  return (icon ?? '').trim() || DEFAULT_CALLOUT_ICON;
}

/**
 * The kinds a block's `text` is an ADDRESS rather than prose.
 *
 * The distinction decides whether the row gets a text editor or its own surface.
 * Core's `holdsProse` answers the same question for the keyboard (what Backspace
 * may merge into what); this answers it for the renderer, and the two agree by
 * construction because the list is the same one.
 */
export function rendersOwnSurface(kind: string): boolean {
  return kind === 'image' || kind === 'bookmark' || kind === 'embed' || kind === 'table'
    // F3 — a synced block's text is the ADDRESS of the block it shows. It was
    // missing from this list, so the row fell through to the prose editor and
    // the menu entry inserted a paragraph containing a URI — F1's defect, on the
    // kind Part F added.
    || kind === 'synced';
}

/**
 * Why this block cannot be typed in, or null.
 *
 * B2 chose prevention over resolution: a block another device is editing is
 * read-only WITH an attribution, so the conflict never happens rather than
 * being merged afterwards. A silently disabled field would read as the app
 * being broken.
 */
export function readOnlyReason(block: NoteBlockView): string | null {
  if (block.lockedBy) return block.lockedBy;
  // A divider has nothing to type. Saying so is better than an input that
  // accepts text and discards it.
  if (block.kind === 'divider') return 'A divider holds no text';
  return null;
}

export function canEdit(block: NoteBlockView): boolean {
  return readOnlyReason(block) === null;
}

/**
 * The one state that cannot resolve itself, so the only one that gets a banner.
 *
 * D4 keeps both versions rather than discarding the loser; a conflict nobody is
 * shown is the same as having discarded it.
 */
export function conflictBanner(blocks: readonly NoteBlockView[]): string | null {
  const count = blocks.filter((b) => b.conflicts.length > 0).length;
  if (count === 0) return null;
  return count === 1
    ? 'One block has two versions kept. Pick which one to keep.'
    : `${count} blocks have two versions kept. Pick which one to keep.`;
}

/**
 * The line beside a kept-both field, which is not the same sentence every time.
 *
 * "Two people typed at once" asks a person to choose between two intentions.
 * "Your device wrote under a lock it no longer held" explains why the sentence
 * on screen is not the one they typed — and without that explanation the app
 * looks like it lost their work rather than like it kept both copies.
 *
 * An unknown reason falls back to naming the field. A renderer that threw on a
 * reason a newer server sent would take the whole page down over a label.
 */
export function conflictLine(conflict: NoteConflictView): string {
  switch (conflict.reason) {
    case 'fenced_stale_epoch':
      return 'Typed under a lock that had already been reissued — both versions are kept.';
    case 'fenced_lease_expired':
      return 'Typed after the lock on this block had expired — both versions are kept.';
    case 'fenced_blocked':
      return 'Another device was editing this block when this arrived — both versions are kept.';
    case 'delete_vs_edit':
      return 'Deleted on one device and edited on another. It is back, undecided.';
    case 'concurrent_text':
      // F3 — the same reason arrives for a block's prose and for a COMMENT on
      // it, and the sentence has to say which: "written in two places at once"
      // over a paragraph nobody touched is how a person concludes the banner is
      // wrong and stops reading it.
      return conflict.field.startsWith('comment:')
        ? 'A comment on this block was written in two places at once. Both versions are kept.'
        : 'Written in two places at once. Both versions are kept.';
    default:
      return `“${conflict.field}” was changed in two places.`;
  }
}

/** A repair explained, so a block that moved says why rather than looking dragged. */
export function repairNote(repair: NoteTreeRepairView): string {
  switch (repair.reason) {
    case 'deleted_parent':
      return 'Moved to the top level — the page it was on was deleted.';
    case 'missing_parent':
      return 'Moved to the top level — the page it was on has not arrived on this device yet.';
    case 'cycle':
      return 'Moved to the top level — it had been nested inside itself.';
  }
}

export function emptyMessage(): string {
  return 'Nothing written yet. Start typing, or link a task, a file or a conversation from anywhere in the workspace.';
}

/* ------------------------------------------------------- cross-mode moves */

/**
 * ADR-029 C2 — the moves a note LINE offers, and the mode that owns each.
 *
 * `mode`/`kind` are what the shared `workspace-create` verb takes, so a new
 * target is a row here rather than a new code path — which is the property C3
 * is after: the agent's `workspace_create` and this menu reach the same
 * registry, so neither can offer something the other cannot make.
 */
export interface NoteSendTarget {
  id: string;
  label: string;
  mode: string;
  kind: string;
}

export const NOTE_SEND_TARGETS: readonly NoteSendTarget[] = [
  { id: 'track', label: 'Make a work item', mode: 'track', kind: 'work-item' },
  { id: 'planner', label: 'Add to planner', mode: 'planner', kind: 'item' },
];

/**
 * Which moves this block can actually perform right now.
 *
 * An empty block has nothing to turn into anything, and offering the action
 * anyway produces a work item called "" that someone has to go and delete.
 */
export function sendTargetsFor(block: NoteBlockView): NoteSendTarget[] {
  return block.text.trim().length > 0 ? [...NOTE_SEND_TARGETS] : [];
}

/**
 * The line a reference chip shows before its label has been resolved.
 *
 * A3 makes references live, so the label arrives from a resolve rather than
 * from the link — which means there is a moment with no label. Showing the raw
 * URI in that moment is honest and stable; showing nothing makes the chip
 * appear to pop into existence.
 */
export function pendingRefLabel(uri: string): string {
  const withoutScheme = uri.replace(/^brainrouter:\/\//, '');
  return withoutScheme.length > 48 ? `${withoutScheme.slice(0, 47)}…` : withoutScheme;
}

/**
 * Which blocks the filter box leaves on screen.
 *
 * `matchIds` is null when nothing was typed, and that is not the same as an
 * empty set: no query shows everything, a query with no hits shows nothing.
 * Collapsing the two would make an empty search look like an empty document.
 *
 * The MATCHING itself is not done here. B5's ranking — prose over link-only,
 * earlier over later, an id like `BR-114` as well as the whole URI — lives in
 * core's `searchNotes`, so the desktop and any other client agree about what a
 * match is. A second scoring implementation in the renderer would rank the same
 * notes differently on two surfaces, which reads as one of them being broken.
 */
export function visibleBlocks(
  blocks: readonly NoteBlockView[],
  matchIds: ReadonlySet<string> | null,
): NoteBlockView[] {
  if (matchIds === null) return [...blocks];
  return blocks.filter((b) => matchIds.has(b.id));
}

/** A2's "what links here", said in words. Zero renders nothing at all. */
export function backlinkNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? '1 block links here' : `${count} blocks link here`;
}
