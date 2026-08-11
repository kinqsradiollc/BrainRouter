/**
 * ADR-029 F3 — what a synced block draws, decided here rather than in the row.
 *
 * The mirror stores an ADDRESS and never the words (`syncedBlock.ts` in core is
 * the whole argument), so this file's job is small and specific: turn what the
 * host resolved into the two things the component needs — a sentence for the
 * states that have no content, and a per-row shape for the state that does.
 *
 * **The rows carry the SOURCE's ids.** That is not a detail: it is what makes
 * "editing either place edits the one block" true without anything redirecting a
 * write. A row rendered here is the one true block, so the editor over it is an
 * ordinary editor writing to an ordinary id.
 *
 * Pure, and it takes no store — the resolution happens host-side because the
 * source is usually on a page the renderer is not holding.
 */

/** One row a mirror shows — the source's own block, at a depth relative to the mirror. */
export interface SyncedRowDto {
  id: string;
  depth: number;
  kind: string;
  text: string;
  level: number | null;
  checked: boolean;
  icon: string | null;
  ordinal: number | null;
  /** B2 — another device holds this block's lease, so the mirror is read-only too. */
  lockedBy: string | null;
}

export interface SyncedReadDto {
  status: 'empty' | 'malformed' | 'not_a_block' | 'denied' | 'gone' | 'cycle' | 'ready';
  uri: string;
  /** Core's sentence for this state. One wording, so three surfaces cannot invent three. */
  note: string;
  sourceId?: string;
  omittedLabel?: string | null;
  rows: SyncedRowDto[];
}

/** The sentence a mirror with nothing to show puts where the content would be. */
export const SYNCED_EMPTY_INVITATION =
  'Pick a block to show here. Editing it in either place edits the one block.';

/**
 * Whether this state has content to draw.
 *
 * A predicate rather than the component testing the string, because `ready` with
 * no rows is a real state — a source that is one empty paragraph — and it must
 * draw an empty editable line rather than falling back to the invitation, which
 * would tell somebody to pick a block they already picked.
 */
export function syncedShowsContent(state: SyncedReadDto | null): boolean {
  return !!state && state.status === 'ready';
}

/**
 * What the mirror's own footer says.
 *
 * Always something: a person looking at a paragraph that also lives somewhere
 * else has no way to tell from the words, and a mirror that looked exactly like
 * an ordinary block would make "I deleted it and it came back" unexplainable.
 */
export function syncedFooter(state: SyncedReadDto | null): string {
  if (!state) return 'Reading the original…';
  return state.note;
}

/** Indentation for a mirrored row, matching the page's own scale. */
export function syncedIndent(depth: number): number {
  return Math.min(Math.max(0, depth), 6) * 18;
}

/**
 * The marker in front of a mirrored row.
 *
 * A mirror renders its source's LIST SHAPE, because a bulleted list that lost
 * its bullets in the second place it appears is not the same block shown twice.
 * The kinds that draw their own surface are not re-drawn here — an image inside
 * a mirror renders as its address with a note, since a second image surface
 * bound to a block on another page is a write path this file has no business
 * opening.
 */
export function syncedMarker(row: SyncedRowDto): string | null {
  switch (row.kind) {
    case 'bullet': return '•';
    case 'numbered': return `${row.ordinal ?? 1}.`;
    case 'todo': return row.checked ? '☑' : '☐';
    case 'quote': return '❝';
    default: return null;
  }
}

/** True for the kinds a mirror shows as a line of text rather than as a surface. */
export function syncedRowIsProse(kind: string): boolean {
  return kind !== 'image' && kind !== 'bookmark' && kind !== 'embed'
    && kind !== 'table' && kind !== 'divider' && kind !== 'synced';
}
